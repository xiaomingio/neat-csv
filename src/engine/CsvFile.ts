/*
File purpose: Index CSV incrementally, edit original records, and save atomically independently of view order.
*/
import { createReadStream, createWriteStream, ReadStream } from 'node:fs';
import { open, stat, rename, unlink, mkdtemp, rm, FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, basename, join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { parse } from 'csv-parse';
import { parse as parseRecord } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import { RE2JS } from 're2js';
import { TEXT_WINDOW_BYTES, TEXT_WINDOW_RECORDS } from '../protocol';
import type { CellEdit, Metadata, Page, Query, Filter, SelectionStats, RowRange, SaveOptions, TextPage, TextEdit, TextEditResult, FileFormat, ChangeOperation, ChangeResult, SearchOptions, SearchResult, CheckOptions, CheckResult, DistinctResult, LocateResult, CellSelection, SelectedCell, RowPinsResult } from '../protocol';

const RECORD_LIMIT = 16 * 1024 * 1024;
const MEMORY_LIMIT = 64 * 1024 * 1024;
const INDEX_BLOCK = 65536;
const READ_BLOCK = 1024 * 1024;
const HISTORY_DISK_LIMIT = 2 * 1024 * 1024 * 1024;
type Version = { size: number; mtimeMs: number; ctimeMs: number; ino: number };
type Patch = { original: string; value: string };
type Checkpoint = { path: string; changes: number; modified: Map<number, number[]>; format: FileFormat; hasHeader: boolean; structural: boolean; rowChanges?: Map<number, number>; modifiedHeaders?: number[]; headerBaseline?: string[]; insertedRows?: RowRange[]; insertedColumns?: number[]; viewState?: { query: Query; pins: number[] } };

export class CsvFile {
  private readonly sourcePath: string;
  private sourceVersion?: Version;
  private temporaryDirectory?: string;
  private checkpoints = new Map<string, Checkpoint>();
  private historyBytes = 0;
  private baseChanges = 0;
  private structuralChanges = false;
  private insertedRows: RowRange[] = [];
  private addedColumns: number[] = [];
  private baselineFile?: CsvFile;
  private rowChanges?: Map<number, number>;
  private modifiedHeaders: number[] = [];
  private headerBaseline?: string[];
  private baseModified = new Map<number, number[]>();
  private format: FileFormat;
  private handle?: FileHandle;
  private stream?: ReadStream;
  private offsets: Float64Array[] = [];
  private records = 0;
  private patches = new Map<number, Map<number, Patch>>();
  private patchBytes = 0;
  private textPatches = new Map<number, Buffer>();
  private textBytes = 0;
  private textRevision = 0;
  private view: number[] | null = null;
  private rowPins: number[] = [];
  private visiblePins: number[] = [];
  private pinnedIndices: number[] = [];
  private queryDirty = false;
  private currentQuery: Query = { filters: [], sort: null };
  private revision = 0;
  private generation = 0;
  private version?: Version;
  private failure?: Error;
  private scanning?: Promise<void>;
  private readAhead?: { start: number; bytes: Buffer };
  private lastReadRow?: number;
  private metadata: Metadata = { headers: [], rows: 0, bytes: 0, scanned: 0, complete: false, delimiter: ',', newline: '\n', hasHeader: true };

  constructor(
    private path: string,
    private readonly onMetadata?: (metadata: Metadata) => void,
    private readonly onError?: (error: Error) => void,
    options: { hasHeader?: boolean; format?: FileFormat } = {},
  ) {
    this.sourcePath = path;
    this.format = this.validateFormat(options.format ?? { encoding: 'utf8' });
    this.metadata.hasHeader = options.hasHeader ?? true;
  }

  async open(): Promise<Metadata> {
    if (!this.sourceVersion) {
      this.sourceVersion = await stat(this.sourcePath);
      if (!['utf8', 'utf-8'].includes(this.format.encoding.toLowerCase())) {
        const converted = await this.temporaryPath();
        await pipeline(createReadStream(this.sourcePath), iconv.decodeStream(this.format.encoding, { stripBOM: false }), iconv.encodeStream('utf8'), createWriteStream(converted, { flags: 'wx' }));
        this.path = converted;
      }
    }
    this.metadata.encoding = this.format.encoding;
    this.handle = await open(this.path, 'r');
    this.version = await this.handle.stat();
    this.metadata.bytes = this.version.size;
    const sample = Buffer.alloc(Math.min(65536, this.version.size));
    await this.handle.read(sample, 0, sample.length, 0);
    if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff) || sample.includes(0)) {
      await this.handle.close();
      this.handle = undefined;
      throw new Error('The file encoding is not UTF-8. Choose the correct encoding to open it.');
    }
    this.metadata.delimiter = this.format.delimiter ?? this.detectDelimiter(sample);
    this.metadata.newline = sample.includes(Buffer.from('\r\n')) ? '\r\n' : sample.includes(13) ? '\r' : '\n';
    const generation = ++this.generation;
    this.onMetadata?.(this.snapshot());
    let ready!: () => void;
    const firstPage = new Promise<void>(done => { ready = done; });
    this.scanning = this.scan(generation, ready).catch(error => {
      if (generation === this.generation) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.onError?.(this.failure);
      }
      ready();
    });
    await firstPage;
    this.assertHealthy();
    return this.snapshot();
  }

  private detectDelimiter(sample: Buffer): string {
    if (extname(this.path).toLowerCase() === '.tsv') return '\t';
    const text = sample.toString('utf8');
    const counts = new Map([[',', 0], [';', 0], ['\t', 0], ['|', 0]]);
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted) {
        if (char === '\r' || char === '\n') break;
        if (counts.has(char)) counts.set(char, counts.get(char)! + 1);
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }

  private async scan(generation: number, ready: () => void): Promise<void> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = parse({ bom: true, delimiter: this.metadata.delimiter, record_delimiter: ['\r\n', '\n', '\r'], info: true, relax_column_count: true, max_record_size: RECORD_LIMIT, skip_empty_lines: false });
    const source = createReadStream(this.path, { highWaterMark: 65536 });
    this.stream = source;
    let previous = 0;
    let emitted = 0;
    const consume = async () => {
      for await (const chunk of source) {
        decoder.decode(chunk as Buffer, { stream: true });
        if (!parser.write(chunk)) await once(parser, 'drain');
      }
      decoder.decode();
      parser.end();
    };
    const pumping = consume().catch(error => { parser.destroy(error as Error); });
    try {
      for await (const item of parser) {
        if (generation !== this.generation) break;
        const end = item.info.bytes as number;
        if (end - previous > RECORD_LIMIT) throw new Error('A CSV record exceeds 16 MB and cannot be opened safely.');
        previous = end;
        if (this.records % INDEX_BLOCK === 0) {
          if (this.offsets.length * INDEX_BLOCK * 8 >= 256 * 1024 * 1024) throw new Error('The CSV row index exceeds 256 MB. Split the file before opening it.');
          this.offsets.push(new Float64Array(INDEX_BLOCK));
        }
        this.offsets[Math.floor(this.records / INDEX_BLOCK)][this.records % INDEX_BLOCK] = end;
        if (this.metadata.hasHeader) {
          if (this.records === 0) this.metadata.headers = item.record;
        } else {
          while (this.metadata.headers.length < item.record.length) {
            let number = this.metadata.headers.length + 1;
            let label = '';
            while (number > 0) {
              number--;
              label = String.fromCharCode(65 + number % 26) + label;
              number = Math.floor(number / 26);
            }
            this.metadata.headers.push(label);
          }
        }
        this.records++;
        this.metadata.rows = Math.max(0, this.records - (this.metadata.hasHeader ? 1 : 0));
        this.metadata.scanned = end;
        if (this.records === 101) ready();
        if (end - emitted >= 1024 * 1024) {
          emitted = end;
          this.onMetadata?.(this.snapshot());
          await new Promise<void>(done => setImmediate(done));
        }
      }
      await pumping;
      if (generation === this.generation) {
        this.metadata.complete = true;
        this.metadata.scanned = this.metadata.bytes;
        this.onMetadata?.(this.snapshot());
      }
    } catch (error) {
      const failure = error instanceof Error && 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
        ? new Error('The file contains invalid UTF-8 bytes. Choose the correct encoding to open it.')
        : error instanceof Error ? error : new Error(String(error));
      if (generation === this.generation) this.failure = failure;
      throw failure;
    } finally {
      source.destroy();
      parser.destroy();
      ready();
    }
  }

  private snapshot(): Metadata { this.rebuildRowPins(); return { ...this.metadata, headers: [...this.metadata.headers], modifiedHeaders: [...this.modifiedHeaders], insertedColumns: [...this.addedColumns], pinnedRows: [...this.visiblePins] }; }

  private rebuildRowPins(): void {
    const indices = new Map<number, number>();
    if (this.view) {
      const pins = new Set(this.rowPins);
      for (let index = 0; index < this.view.length && indices.size < pins.size; index++) if (pins.has(this.view[index])) indices.set(this.view[index], index);
    } else for (const row of this.rowPins) if (row < this.metadata.rows) indices.set(row, row);
    this.visiblePins = this.rowPins.filter(row => indices.has(row));
    this.pinnedIndices = [...indices.values()].sort((a, b) => a - b);
  }

  private rowAtView(index: number): number {
    if (index < this.visiblePins.length) return this.visiblePins[index];
    let base = index - this.visiblePins.length;
    for (const pin of this.pinnedIndices) { if (pin > base) break; base++; }
    return this.view ? this.view[base] : base;
  }

  private rowPinState(): RowPinsResult {
    return { rows: [...this.rowPins], visibleRows: [...this.visiblePins], total: this.view?.length ?? this.metadata.rows };
  }

  async pinRows(rows: number[]): Promise<RowPinsResult> {
    this.assertHealthy();
    if (this.queryDirty) await this.query(this.currentQuery);
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !Number.isSafeInteger(row) || row < 0 || row >= this.metadata.rows)) throw new Error('Pin up to 100 valid rows.');
    this.rowPins = [...new Set(rows)]; this.rebuildRowPins(); this.revision++;
    return this.rowPinState();
  }
  private assertHealthy(): void {
    if (this.failure) throw this.failure;
    if (!this.handle) throw new Error('The file is closed.');
  }
  private end(record: number): number { return this.offsets[Math.floor(record / INDEX_BLOCK)][record % INDEX_BLOCK]; }
  private rowStart(row: number): number {
    const record = row + (this.metadata.hasHeader ? 1 : 0);
    return record === 0 ? 0 : this.end(record - 1);
  }
  private rowEnd(row: number): number { return this.end(row + (this.metadata.hasHeader ? 1 : 0)); }

  private async raw(row: number): Promise<Buffer> {
    return this.textPatches.get(row + (this.metadata.hasHeader ? 1 : 0)) ?? this.sourceRaw(row);
  }

  private async record(record: number, edits = true, cells = true): Promise<Buffer> {
    const row = record - (this.metadata.hasHeader ? 1 : 0);
    if (row >= 0) {
      const raw = edits ? await this.raw(row) : await this.sourceRaw(row);
      const patches = edits && cells ? this.patches.get(row) : undefined;
      return patches ? this.modified(raw, patches, row) : raw;
    }
    if (edits && this.textPatches.has(0)) return this.textPatches.get(0)!;
    const bytes = Buffer.alloc(this.end(0));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await this.handle!.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('The file contents changed. Reload the file.');
      offset += result.bytesRead;
    }
    return bytes;
  }

  private async sourceRaw(row: number): Promise<Buffer> {
    this.assertHealthy();
    if (!Number.isInteger(row) || row < 0 || row >= this.metadata.rows) throw new Error('Row is outside the file.');
    const adjacent = this.lastReadRow !== undefined && Math.abs(row - this.lastReadRow) === 1;
    this.lastReadRow = row;
    const start = this.rowStart(row);
    const length = this.rowEnd(row) - start;
    if (this.readAhead && start >= this.readAhead.start && start + length <= this.readAhead.start + this.readAhead.bytes.length) {
      return this.readAhead.bytes.subarray(start - this.readAhead.start, start - this.readAhead.start + length);
    }
    // Read ahead for adjacent rows in either direction; random access reads one record.
    const prefetch = adjacent && length <= READ_BLOCK;
    const readStart = prefetch ? Math.floor(start / READ_BLOCK) * READ_BLOCK : start;
    const readLength = prefetch ? Math.min(Math.max(READ_BLOCK, start + length - readStart), this.metadata.bytes - readStart) : length;
    const buffer = Buffer.alloc(readLength);
    let read = 0;
    while (read < readLength) {
      const result = await this.handle!.read(buffer, read, readLength - read, readStart + read);
      if (!result.bytesRead) throw new Error('The file contents changed. Reload the file.');
      read += result.bytesRead;
    }
    if (prefetch) this.readAhead = { start: readStart, bytes: buffer };
    return buffer.subarray(start - readStart, start - readStart + length);
  }

  private async values(row: number): Promise<string[]> {
    const raw = await this.raw(row);
    const values = this.parseValues(raw, row);
    for (const [col, patch] of this.patches.get(row) ?? []) values[col] = patch.value;
    return values;
  }

  private parseValues(raw: Buffer, row: number): string[] {
    const records = parseRecord(raw, { bom: !this.metadata.hasHeader && row === 0, delimiter: this.metadata.delimiter, record_delimiter: ['\r\n', '\n', '\r'], relax_column_count: true, max_record_size: RECORD_LIMIT }) as string[][];
    return records[0] ?? [''];
  }

  get changes(): number {
    if (this.rowChanges && !this.structuralChanges) return [...this.rowChanges.values()].reduce((sum, count) => sum + count, 0);
    return this.baseChanges + this.textPatches.size + [...this.patches.values()].reduce((count, patches) => count + patches.size, 0);
  }

  async textPage(start: number, count: number): Promise<TextPage> {
    this.assertHealthy();
    if (!Number.isSafeInteger(start) || start < 0 || start > this.records || !Number.isSafeInteger(count) || count < 1 || count > TEXT_WINDOW_RECORDS) throw new Error('Invalid text section.');
    const parts: Buffer[] = []; let bytes = 0;
    for (let index = start; index < Math.min(this.records, start + count); index++) {
      const record = await this.record(index);
      if (bytes + record.length > TEXT_WINDOW_BYTES) {
        if (!parts.length) throw new Error('This record is too large for Text. Edit it in Table instead.');
        break;
      }
      parts.push(record); bytes += record.length;
    }
    return { start, count: parts.length, total: this.records, text: Buffer.concat(parts).toString('utf8'), revision: this.textRevision, delimiter: this.metadata.delimiter, newline: this.metadata.newline };
  }

  async textEdit(edit: TextEdit): Promise<TextEditResult> {
    this.assertHealthy();
    if (edit.revision !== this.textRevision) throw new Error('The text section changed. Reload Text before editing.');
    if (Buffer.byteLength(edit.text) > TEXT_WINDOW_BYTES) throw new Error('This text section exceeds 1 MB.');
    const before = await this.textPage(edit.start, edit.count);
    if (before.count !== edit.count || edit.count === 0) throw new Error('Invalid text section.');
    if (before.text === edit.text) return { before: before.text, page: before, changes: this.changes };
    let parsed: { record: string[]; info: { bytes: number } }[];
    const bytes = Buffer.from(edit.text);
    try {
      parsed = parseRecord(bytes, { bom: edit.start === 0, delimiter: this.metadata.delimiter, record_delimiter: ['\r\n', '\n', '\r'], info: true, relax_column_count: true, max_record_size: RECORD_LIMIT }) as unknown as typeof parsed;
      if (parsed.length !== edit.count) throw new Error(`Keep ${edit.count} records in this section. Adding or deleting records is not supported yet.`);
      if (edit.start + edit.count < this.records && !/[\r\n]$/.test(edit.text)) throw new Error('Keep a line break at the end of this section.');
      if (this.metadata.hasHeader && edit.start === 0 && parsed[0].record.length !== this.metadata.headers.length) throw new Error('Keep the existing number of header columns.');
    } catch (error) {
      return { before: before.text, page: before, changes: this.changes, error: error instanceof Error ? error.message : String(error) };
    }
    const historyParts: Buffer[] = [], historyCells: CellEdit[] = [];
    for (let record = edit.start; record < edit.start + edit.count; record++) {
      historyParts.push(await this.record(record, true, false));
      const row = record - (this.metadata.hasHeader ? 1 : 0);
      for (const [col, patch] of this.patches.get(row) ?? []) historyCells.push({ row, col, value: patch.value });
    }
    const beforeState = { text: Buffer.concat(historyParts).toString('utf8'), cells: historyCells };
    if (Buffer.byteLength(beforeState.text) > TEXT_WINDOW_BYTES) throw new Error('This section contains a large original record. Edit it in Table instead.');
    const nextText = new Map(this.textPatches), nextCells = new Map(this.patches);
    let used = this.textBytes, cursor = 0;
    for (let index = 0; index < parsed.length; index++) {
      const record = edit.start + index;
      const raw = bytes.subarray(cursor, parsed[index].info.bytes); cursor = parsed[index].info.bytes;
      const source = await this.record(record, false);
      used -= nextText.get(record)?.length ?? 0;
      if (raw.equals(source)) nextText.delete(record);
      else { nextText.set(record, Buffer.from(raw)); used += raw.length; }
      nextCells.delete(record - (this.metadata.hasHeader ? 1 : 0));
    }
    const cellBytes = [...nextCells.values()].reduce((sum, cells) => sum + [...cells.values()].reduce((size, patch) => size + (patch.original.length + patch.value.length) * 2 + 64, 0), 0);
    if (used + cellBytes > MEMORY_LIMIT) throw new Error('Text edits exceed the 64 MB edit budget. Save your changes first.');
    this.textPatches = nextText; this.textBytes = used; this.patches = nextCells; this.patchBytes = cellBytes;
    if (this.metadata.hasHeader && edit.start === 0) {
      this.headerBaseline ??= [...(this.structuralChanges ? this.metadata.headers : (await this.baseline()).metadata.headers)];
      this.metadata.headers = parsed[0].record;
      this.modifiedHeaders = parsed[0].record.flatMap((name, col) => name !== this.headerBaseline![col] ? [col] : []);
    }
    // Text edits address original records; defer queries until Table reads to avoid a full scan per keystroke.
    this.queryDirty = Boolean(this.currentQuery.sort || this.currentQuery.filters.length);
    this.textRevision++;
    if (this.rowChanges && !this.structuralChanges) {
      for (let record = edit.start; record < edit.start + edit.count; record++) await this.refreshRowBaseline(record - (this.metadata.hasHeader ? 1 : 0), false);
    }
    this.onMetadata?.(this.snapshot());
    return { before: before.text, beforeState, page: await this.textPage(edit.start, edit.count), changes: this.changes };
  }

  async page(start: number, count: number): Promise<Page> {
    if (this.queryDirty) await this.query(this.currentQuery);
    this.assertHealthy();
    if (!this.view) this.rebuildRowPins();
    start = Math.max(0, Math.floor(start));
    count = Math.max(0, Math.min(500, Math.floor(count)));
    const total = this.view?.length ?? this.metadata.rows;
    const rows: Page['rows'] = [];
    let bytes = 0;
    for (let i = start; i < Math.min(total, start + count); i++) {
      const id = this.rowAtView(i);
      const values = await this.values(id);
      bytes += values.reduce((sum, value) => sum + value.length * 2, 0);
      if (bytes > 8 * 1024 * 1024 && rows.length) break;
      let modified: number[] = [];
      if (this.textPatches.has(id + (this.metadata.hasHeader ? 1 : 0))) {
        const original = this.parseValues(await this.sourceRaw(id), id);
        modified = Array.from({ length: Math.max(values.length, original.length) }, (_, col) => col).filter(col => values[col] !== original[col]);
      } else modified = [...(this.patches.get(id)?.keys() ?? [])];
      modified = [...new Set([...(this.baseModified.get(id) ?? []), ...modified])];
      if (this.rowChanges && !this.structuralChanges) {
        const original = await (await this.baseline()).values(id);
        modified = Array.from({ length: Math.max(values.length, original.length) }, (_, col) => col).filter(col => (values[col] ?? '') !== (original[col] ?? ''));
      }
      rows.push({ id, values, modified, ...(this.insertedRows.some(range => id >= range.start && id < range.start + range.count) ? { inserted: true } : {}) });
    }
    return { start, total, rows, insertedColumns: [...this.addedColumns], pinnedRows: [...this.visiblePins] };
  }

  async copy(start: number, count: number, columns: number[], ranges?: RowRange[], cells?: SelectedCell[], includeHeaders = false): Promise<string> {
    if (this.queryDirty) await this.query(this.currentQuery);
    this.assertHealthy();
    const selected = this.validateSelection(start, count, columns, ranges);
    const rowCount = selected.reduce((sum, range) => sum + range.count, 0);
    const groups = this.sparseCells({ start, count, columns, ranges, cells });
    if (groups && (groups.size !== rowCount || [...groups.values()].some(group => group.size !== columns.length || columns.some(col => !group.has(col))))) throw new Error('Copy and paste require a rectangular selection. Select one range.');
    if ((rowCount + (includeHeaders ? 1 : 0)) * columns.length > 100000) throw new Error('Copy up to 100,000 cells at once. Select a smaller range.');
    const revision = this.revision;
    const single = !includeHeaders && rowCount === 1 && columns.length === 1;
    const encode = (value: string) => !single && /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    const lines: string[] = includeHeaders ? [columns.map(col => encode(this.metadata.headers[col] ?? '')).join('\t')] : [];
    let bytes = lines.length ? Buffer.byteLength(lines[0]) : 0;
    if (bytes > 8 * 1024 * 1024) throw new Error('Copied content exceeds 8 MB. Select a smaller range.');
    for (const index of this.selectedRows(selected)) {
      const id = this.rowAtView(index);
      const values = await this.values(id);
      const line = columns.map(col => encode(values[col] ?? '')).join('\t');
      bytes += Buffer.byteLength(line) + (lines.length ? 1 : 0);
      if (bytes > 8 * 1024 * 1024) throw new Error('Copied content exceeds 8 MB. Select a smaller range.');
      lines.push(line);
      if (index % 4096 === 0) await new Promise<void>(done => setImmediate(done));
      if (revision !== this.revision) throw new Error('The selection changed. Copy it again.');
    }
    return lines.join('\n');
  }

  private validateSelection(start: number, count: number, columns: number[], ranges?: RowRange[]): RowRange[] {
    const total = this.view?.length ?? this.metadata.rows;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || start + count > total || !columns.length || columns.some(col => !Number.isInteger(col) || col < 0 || col >= this.metadata.headers.length) || !Number.isSafeInteger(count * columns.length)) {
      throw new Error('Selection is outside the table. Select a valid range.');
    }
    const selected = ranges ?? [{ start, count }];
    let end = start;
    if (!selected.length || selected[0].start !== start) throw new Error('Selection is outside the table. Select a valid range.');
    for (const range of selected) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.count) || range.count < 1 || range.start < end || range.start + range.count > start + count) throw new Error('Selection is outside the table. Select a valid range.');
      end = range.start + range.count;
    }
    if (end !== start + count) throw new Error('Selection is outside the table. Select a valid range.');
    return selected;
  }

  private *selectedRows(ranges: RowRange[]): Generator<number> {
    for (const range of ranges) {
      for (let row = range.start; row < range.start + range.count; row++) yield row;
    }
  }

  private sparseCells(selection: CellSelection): Map<number, Set<number>> | undefined {
    if (selection.cells === undefined) return undefined;
    if (!Array.isArray(selection.cells) || !selection.cells.length || selection.cells.length > 100000) throw new Error('Select up to 100,000 individual cells.');
    const ranges = this.validateSelection(selection.start, selection.count, selection.columns, selection.ranges);
    const columns = new Set(selection.columns), groups = new Map<number, Set<number>>();
    for (const cell of selection.cells) {
      let low = 0, high = ranges.length;
      while (low < high) { const mid = (low + high) >>> 1; if (ranges[mid].start <= cell?.row) low = mid + 1; else high = mid; }
      const range = ranges[low - 1];
      if (!cell || !Number.isSafeInteger(cell.row) || !Number.isInteger(cell.col) || !columns.has(cell.col) || !range || cell.row >= range.start + range.count) throw new Error('Selection is outside the table. Select a valid range.');
      if (!groups.has(cell.row)) groups.set(cell.row, new Set());
      groups.get(cell.row)!.add(cell.col);
    }
    return groups;
  }

  private number(value: string): number | null {
    const text = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  async stats(start: number, count: number, columns: number[], ranges?: RowRange[], cells?: SelectedCell[]): Promise<SelectionStats> {
    if (this.queryDirty) await this.query(this.currentQuery);
    this.assertHealthy();
    const selected = this.validateSelection(start, count, columns, ranges);
    const rowCount = selected.reduce((sum, range) => sum + range.count, 0);
    const groups = this.sparseCells({ start, count, columns, ranges, cells });
    const revision = this.revision;
    let sum = 0, correction = 0, numericCount = 0, nonEmptyCount = 0;
    let min: number | null = null, max: number | null = null;
    for (const index of groups ? groups.keys() : this.selectedRows(selected)) {
      const values = await this.values(this.rowAtView(index));
      for (const col of groups?.get(index) ?? columns) {
        if ((values[col] ?? '').trim()) nonEmptyCount++;
        const value = this.number(values[col] ?? '');
        if (value === null) continue;
        min = min === null ? value : Math.min(min, value);
        max = max === null ? value : Math.max(max, value);
        const next = sum + value;
        correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
        sum = next;
        numericCount++;
        if (!Number.isFinite(sum) || !Number.isFinite(correction)) throw new Error('The selection sum exceeds the numeric range. Select a smaller range.');
      }
      if (index % 4096 === 0) await new Promise<void>(done => setImmediate(done));
      if (revision !== this.revision) throw new Error('The selection changed. Select it again.');
    }
    sum += correction;
    if (!Number.isFinite(sum)) throw new Error('The selection sum exceeds the numeric range. Select a smaller range.');
    return { count: groups ? [...groups.values()].reduce((sum, group) => sum + group.size, 0) : rowCount * columns.length, numericCount, nonEmptyCount, min, max, sum, average: numericCount ? sum / numericCount : null };
  }

  private filterPredicate(filter: Filter): (values: string[]) => boolean {
    if (!Number.isInteger(filter.col) || filter.col < 0 || filter.col >= this.metadata.headers.length) throw new Error('Filter column is outside the table.');
    if (filter.type === 'values') {
      if (!Array.isArray(filter.values) || !filter.values.length || filter.values.length > 10000 || filter.values.some(value => typeof value !== 'string')) throw new Error('Choose at least one valid value to filter.');
      let bytes = 0;
      for (const value of filter.values) { bytes += Buffer.byteLength(JSON.stringify(value)) + 1; if (bytes > 8 * 1024 * 1024) throw new Error('Too many distinct values. Use Text or Regular expression.'); }
      const selected = new Set(filter.values);
      return values => selected.has(values[filter.col] ?? '');
    }
    if (filter.type === 'regex') {
      if (typeof filter.text !== 'string') throw new Error('Invalid regular expression filter.');
      const options: SearchOptions = { text: filter.text, regex: true };
      const regex = this.matcher(options);
      return values => {
        const value = values[filter.col] ?? '';
        this.regexValue(options, value);
        return regex.matcher(value).find();
      };
    }
    if (filter.type === 'empty' || filter.type === 'notEmpty') {
      return values => Boolean((values[filter.col] ?? '').trim()) === (filter.type === 'notEmpty');
    }
    if (filter.type === 'number') {
      if (!Number.isFinite(filter.value) || !['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'].includes(filter.operator) || (filter.operator === 'between' && (!Number.isFinite(filter.max) || filter.max! < filter.value))) throw new Error('Invalid numeric filter. Check the range limits.');
      return values => {
        const value = this.number(values[filter.col] ?? '');
        if (value === null) return false;
        switch (filter.operator) {
          case 'eq': return value === filter.value;
          case 'ne': return value !== filter.value;
          case 'gt': return value > filter.value;
          case 'gte': return value >= filter.value;
          case 'lt': return value < filter.value;
          case 'lte': return value <= filter.value;
          case 'between': return value >= filter.value && value <= filter.max!;
        }
      };
    }
    if ((filter.type !== undefined && filter.type !== 'text') || !('text' in filter) || typeof filter.text !== 'string') throw new Error('Invalid text filter.');
    const text = filter.text.toLowerCase();
    return values => (values[filter.col] ?? '').toLowerCase().includes(text);
  }

  async query(query: Query): Promise<RowPinsResult> {
    this.assertHealthy();
    if (!this.metadata.complete) throw new Error('The file is being indexed. Filtering and sorting are available when indexing finishes.');
    const filters = query.filters.map(filter => this.filterPredicate(filter));
    const sort = query.sort;
    if (sort && (!Number.isInteger(sort.col) || sort.col < 0 || sort.col >= this.metadata.headers.length || ![1, -1].includes(sort.direction) || ![true, false, 'auto'].includes(sort.numeric))) throw new Error('Invalid sort options.');
    const revision = ++this.revision;
    if (!filters.length && !sort) {
      this.view = null;
      this.currentQuery = query; this.queryDirty = false;
      this.rebuildRowPins(); return this.rowPinState();
    }
    const entries: { id: number; key: string }[] = [];
    let budget = 0;
    let hasNumeric = false, hasText = false;
    for (let row = 0; row < this.metadata.rows; row++) {
      if (revision !== this.revision) throw new Error('The query was canceled by a newer operation.');
      const values = await this.values(row);
      const key = sort ? values[sort.col] ?? '' : '';
      if (sort?.numeric === 'auto' && key.trim()) {
        if (this.number(key) === null) hasText = true;
        else hasNumeric = true;
      }
      if (filters.every(matches => matches(values))) {
        budget += 64 + key.length * 2;
        if (budget > MEMORY_LIMIT) throw new Error('Filter or sort results exceed the 64 MB memory budget. Narrow the filter.');
        entries.push({ id: row, key });
      }
      if (row % 4096 === 0) await new Promise<void>(done => setImmediate(done));
    }
    const numeric = sort?.numeric === 'auto' ? hasNumeric && !hasText : sort?.numeric;
    if (sort) entries.sort((a, b) => {
      let comparison: number;
      if (numeric) {
        const left = this.number(a.key), right = this.number(b.key);
        if ((left === null) !== (right === null)) return left !== null ? -1 : 1;
        comparison = left !== null && right !== null ? left - right : 0;
      } else {
        if (!a.key.trim() || !b.key.trim()) return a.key.trim() ? -1 : b.key.trim() ? 1 : a.id - b.id;
        comparison = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      }
      return comparison * sort.direction || a.id - b.id;
    });
    if (revision !== this.revision) throw new Error('The query was canceled by a newer operation.');
    this.view = entries.map(entry => entry.id);
    this.currentQuery = query; this.queryDirty = false;
    this.rebuildRowPins(); return this.rowPinState();
  }

  async edit(edit: CellEdit): Promise<{ value: string; changes: number }> {
    this.assertHealthy();
    if (!Number.isInteger(edit.col) || edit.col < 0 || edit.col >= this.metadata.headers.length) throw new Error('Column is outside the table.');
    const values = await this.values(edit.row);
    if (edit.col >= values.length) throw new Error('This record is missing this field. Add it in Text mode or use Fill selection.');
    const value = values[edit.col];
    const old = this.patches.get(edit.row)?.get(edit.col);
    const original = old?.original ?? value;
    const nextBytes = this.patchBytes - (old ? (old.original.length + old.value.length) * 2 + 64 : 0) + (edit.value === original ? 0 : (original.length + edit.value.length) * 2 + 64);
    if (Buffer.byteLength(edit.value) > RECORD_LIMIT || nextBytes + this.textBytes > MEMORY_LIMIT) throw new Error('Edits exceed the memory budget. Save your changes or shorten the content.');
    const previousBytes = this.patchBytes;
    this.patchBytes = nextBytes;
    if (edit.value === original) {
      this.patches.get(edit.row)?.delete(edit.col);
      if (!this.patches.get(edit.row)?.size) this.patches.delete(edit.row);
    } else {
      if (!this.patches.has(edit.row)) this.patches.set(edit.row, new Map());
      this.patches.get(edit.row)!.set(edit.col, { original, value: edit.value });
    }
    this.revision++;
    if (this.currentQuery.filters.length || this.currentQuery.sort) {
      try { await this.query(this.currentQuery); }
      catch (error) {
        if (old) {
          if (!this.patches.has(edit.row)) this.patches.set(edit.row, new Map());
          this.patches.get(edit.row)!.set(edit.col, old);
        } else {
          this.patches.get(edit.row)?.delete(edit.col);
          if (!this.patches.get(edit.row)?.size) this.patches.delete(edit.row);
        }
        this.patchBytes = previousBytes;
        throw error;
      }
    }
    this.textRevision++;
    if (this.rowChanges && !this.structuralChanges) await this.refreshRowBaseline(edit.row, true);
    return { value, changes: this.changes };
  }

  private tokenizeRecord(raw: Buffer, first: boolean): { bom: string; suffix: string; tokens: string[] } {
    const decoded = raw.toString('utf8');
    const bom = first && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? '\ufeff' : '';
    const text = bom ? decoded.slice(1) : decoded;
    const suffix = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : text.endsWith('\r') ? '\r' : '';
    const body = suffix ? text.slice(0, -suffix.length) : text;
    const tokens: string[] = [];
    let quoted = false, start = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '"') {
        if (quoted && body[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted && body[i] === this.metadata.delimiter) {
        tokens.push(body.slice(start, i));
        start = i + 1;
      }
    }
    tokens.push(body.slice(start));
    return { bom, suffix, tokens };
  }

  private movedColumn(raw: Buffer, col: number, before: number, first: boolean): Buffer {
    const { bom, suffix, tokens } = this.tokenizeRecord(raw, first);
    while (tokens.length < this.metadata.headers.length) tokens.push('');
    const [field] = tokens.splice(col, 1);
    tokens.splice(before > col ? before - 1 : before, 0, field);
    const bytes = Buffer.from(bom + tokens.join(this.metadata.delimiter) + suffix);
    if (bytes.length > RECORD_LIMIT) throw new Error('The edited CSV record exceeds 16 MB and cannot be saved.');
    return bytes;
  }

  private projectRecord(raw: Buffer, columns: number[], first: boolean): Buffer {
    const { bom, suffix, tokens } = this.tokenizeRecord(raw, first);
    const fields = columns.map(col => tokens[col] ?? '');
    if (fields.length === 1 && fields[0] === '') fields[0] = '""';
    return Buffer.from(bom + fields.join(this.metadata.delimiter) + suffix);
  }

  private modified(raw: Buffer, patches: Map<number, Patch>, row: number): Buffer {
    const { bom, suffix, tokens } = this.tokenizeRecord(raw, !this.metadata.hasHeader && row === 0);
    for (const [col, patch] of patches) {
      const value = patch.value;
      tokens[col] = value.includes(this.metadata.delimiter) || /["\r\n]/.test(value) || (tokens.length === 1 && value === '') ? `"${value.replace(/"/g, '""')}"` : value;
    }
    const result = Buffer.from(bom + tokens.join(this.metadata.delimiter) + suffix);
    if (result.length > RECORD_LIMIT) throw new Error('The edited CSV record exceeds 16 MB and cannot be saved.');
    return result;
  }

  private validateFormat(format: FileFormat): FileFormat {
    if (!iconv.encodingExists(format.encoding)) throw new Error('Unsupported encoding.');
    if (format.delimiter !== undefined && (!/^[,;\t|:]$/.test(format.delimiter))) throw new Error('Choose comma, semicolon, tab, pipe or colon as delimiter.');
    return { ...format };
  }

  private async temporaryPath(): Promise<string> {
    this.temporaryDirectory ??= await mkdtemp(join(tmpdir(), 'vscode-csv-work-'));
    return join(this.temporaryDirectory, `${randomUUID()}.csv`);
  }

  async configure(format: FileFormat): Promise<Metadata> {
    if (this.changes) throw new Error('Save or discard changes before changing file format.');
    const next = this.validateFormat(format), previous = this.format;
    this.format = next;
    try {
      await this.reload(); await this.ready(); return this.snapshot();
    } catch (error) {
      this.format = previous;
      try { await this.reload(); await this.ready(); }
      catch { /* Keep the engine error if the source also changed externally. */ }
      throw error;
    }
  }

  private async ready(): Promise<void> { await this.scanning; this.assertHealthy(); }

  private async baseline(): Promise<CsvFile> {
    if (!this.baselineFile) {
      this.baselineFile = new CsvFile(this.sourcePath, undefined, undefined, { hasHeader: this.metadata.hasHeader, format: this.format });
      await this.baselineFile.open(); await this.baselineFile.ready();
    }
    return this.baselineFile;
  }

  private async refreshRowBaseline(row: number, restoreOriginal: boolean): Promise<void> {
    const baseline = await this.baseline(), record = row + (this.metadata.hasHeader ? 1 : 0);
    const originalBytes = await baseline.record(record);
    if (row < 0) { this.rowChanges!.set(row, (await this.record(record)).equals(originalBytes) ? 0 : 1); return; }
    const original = await baseline.values(row), current = await this.values(row);
    const differences = Array.from({ length: Math.max(original.length, current.length) }, (_, col) => col).filter(col => (original[col] ?? '') !== (current[col] ?? ''));
    if (!differences.length && restoreOriginal) {
      const previous = this.textPatches.get(record);
      const cellPatches = this.patches.get(row);
      const nextTextBytes = this.textBytes - (previous?.length ?? 0) + originalBytes.length;
      const removedCells = [...(cellPatches?.values() ?? [])].reduce((sum, patch) => sum + (patch.original.length + patch.value.length) * 2 + 64, 0);
      if (nextTextBytes + this.patchBytes - removedCells <= MEMORY_LIMIT) {
        this.patches.delete(row); this.patchBytes -= removedCells;
        this.textPatches.set(record, Buffer.from(originalBytes)); this.textBytes = nextTextBytes;
      }
    }
    this.rowChanges!.set(row, differences.length || ((await this.record(record)).equals(originalBytes) ? 0 : 1));
    if (differences.length) this.baseModified.set(row, differences); else this.baseModified.delete(row);
  }

  async locate(row: number): Promise<LocateResult> {
    await this.ready();
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.metadata.rows) throw new Error('Row is outside the file.');
    if (this.queryDirty) await this.query(this.currentQuery);
    const index = this.view ? this.view.indexOf(row) : row;
    const pin = this.visiblePins.indexOf(row);
    return { row, index: index < 0 ? null : pin >= 0 ? pin : this.visiblePins.length + index - this.pinnedIndices.filter(value => value < index).length };
  }

  private validateColumns(columns?: number[]): number[] {
    const result = columns ?? this.metadata.headers.map((_, index) => index);
    if (!result.length || new Set(result).size !== result.length || result.some(col => !Number.isInteger(col) || col < 0 || col >= this.metadata.headers.length)) throw new Error('Choose valid columns.');
    return result;
  }

  private matcher(options: SearchOptions): RE2JS {
    if (!options.text || options.text.length > 1024) throw new Error('Enter a search pattern of 1–1,024 characters.');
    const pattern = options.regex ? options.text : options.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return RE2JS.compile(pattern, options.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  }

  private regexValue(options: SearchOptions, value: string): void {
    if (options.regex && value.length > 65536) throw new Error('Regex search supports cells up to 65,536 characters. Use plain text search for larger cells.');
  }

  private replaceValue(regex: RE2JS, value: string, replacement: string, literal: boolean): string {
    const matcher = regex.matcher(value), parts: string[] = [];
    let cursor = 0, bytes = 0, count = 0;
    const append = (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > RECORD_LIMIT) throw new Error('A replacement result exceeds 16 MB.');
      parts.push(text);
    };
    while (matcher.find()) {
      if (++count > 100000) throw new Error('A cell contains more than 100,000 replacement matches. Use a more specific pattern.');
      append(value.slice(cursor, matcher.start()));
      append(literal ? replacement : replacement.replace(/\$([$&`']|\d{1,2})/g, (token, group: string) => {
        if (group === '$') return '$';
        if (group === '&') return matcher.group() ?? '';
        if (group === '`') return value.slice(0, matcher.start());
        if (group === "'") return value.slice(matcher.end());
        const index = Number(group);
        if (index > 0 && index <= matcher.groupCount()) return matcher.group(index) ?? '';
        if (group.length === 2 && Number(group[0]) > 0 && Number(group[0]) <= matcher.groupCount()) return (matcher.group(Number(group[0])) ?? '') + group[1];
        return token;
      }));
      cursor = matcher.end();
    }
    append(value.slice(cursor));
    return parts.join('');
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    await this.ready();
    const regex = this.matcher(options), columns = this.validateColumns(options.columns);
    const selection = options.selection;
    const groups = selection ? this.sparseCells(selection) : undefined;
    const cells = groups ? new Map([...groups].map(([index, columns]) => [this.rowAtView(index), columns])) : undefined;
    const rows = selection ? cells ? new Set(cells.keys()) : this.selectionRows(selection) : undefined;
    const selectedColumns = selection ? new Set(selection.columns) : undefined;
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 200)));
    const matches: SearchResult['matches'] = []; let total = 0, remaining = 0;
    for (let row = 0; row < this.metadata.rows; row++) {
      if (rows && !rows.has(row)) continue;
      const values = await this.values(row);
      for (const col of columns) {
        if (selectedColumns && !selectedColumns.has(col) || cells && !cells.get(row)?.has(col)) continue;
        const value = values[col] ?? ''; this.regexValue(options, value);
        if (regex.matcher(value).find()) {
          total++;
          if (!options.after || row > options.after.row || (row === options.after.row && col > options.after.col)) { remaining++; if (matches.length < limit) matches.push({ row, col, value: value.slice(0, 512) }); }
        }
      }
      if (row % 4096 === 0) await new Promise<void>(done => setImmediate(done));
    }
    return { matches, total, truncated: remaining > matches.length };
  }

  async check(options: CheckOptions): Promise<CheckResult> {
    await this.ready();
    if (!['duplicates', 'missing', 'ragged'].includes(options.kind)) throw new Error('Invalid check.');
    const columns = this.validateColumns(options.columns);
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 200)));
    if (options.after && (!Number.isSafeInteger(options.after.row) || options.after.row < 0 || (options.after.col !== undefined && (!Number.isInteger(options.after.col) || options.after.col < 0)))) throw new Error('Invalid data-check position.');
    const issues: CheckResult['issues'] = []; let total = 0, budget = 0, remaining = 0;
    const seen = new Map<string, number>();
    const report = (row: number, col?: number, value?: string) => {
      total++;
      if (!options.after || row > options.after.row || (row === options.after.row && (col ?? -1) > (options.after.col ?? -1))) {
        remaining++;
        if (issues.length < limit) issues.push({ row, col, value: value?.slice(0, 512) });
      }
    };
    for (let row = 0; row < this.metadata.rows; row++) {
      const values = await this.values(row);
      if (options.kind === 'ragged') {
        if (values.length !== this.metadata.headers.length) report(row, undefined, `${values.length} fields; expected ${this.metadata.headers.length}`);
      } else if (options.kind === 'missing') {
        for (const col of columns) if (!(values[col] ?? '').trim()) report(row, col, '');
      } else {
        const key = JSON.stringify(columns.map(col => values[col] ?? ''));
        if (seen.has(key)) report(row, columns.length === 1 ? columns[0] : undefined, columns.length === 1 ? values[columns[0]] : key);
        else {
          budget += key.length * 2 + 64;
          if (budget > MEMORY_LIMIT) throw new Error('Duplicate checking exceeds the 64 MB memory budget. Select fewer columns or a smaller file.');
          seen.set(key, row);
        }
      }
      if (row % 4096 === 0) await new Promise<void>(done => setImmediate(done));
    }
    return { issues, total, truncated: remaining > issues.length };
  }

  async distinct(col: number): Promise<DistinctResult> {
    await this.ready(); this.validateColumns([col]);
    const counts = new Map<string, number>();
    let memory = 0, response = 0;
    for (let row = 0; row < this.metadata.rows; row++) {
      const value = (await this.values(row))[col] ?? '';
      const count = counts.get(value);
      if (count !== undefined) counts.set(value, count + 1);
      else {
        memory += value.length * 2 + 96;
        response += Buffer.byteLength(JSON.stringify(value)) + 40;
        if (counts.size >= 10000 || memory > MEMORY_LIMIT || response > 8 * 1024 * 1024) throw new Error('Too many distinct values. Use Text or Regular expression.');
        counts.set(value, 1);
      }
      if (row % 4096 === 0) await new Promise<void>(done => setImmediate(done));
    }
    const values = [...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([value, count]) => ({ value, count }));
    return { values, total: values.length };
  }

  private selectionRows(selection: CellSelection): Set<number> {
    this.validateColumns(selection.columns);
    const ranges = this.validateSelection(selection.start, selection.count, selection.columns, selection.ranges);
    const rows = new Set<number>();
    for (const index of this.selectedRows(ranges)) {
      if (rows.size >= 1000000) throw new Error('A batch selection supports up to 1,000,000 rows.');
      rows.add(this.rowAtView(index));
    }
    return rows;
  }

  private serialize(values: string[], bom = false): Buffer {
    const text = values.map(value => /["\r\n]/.test(value) || value.includes(this.metadata.delimiter) || (values.length === 1 && value === '') ? `"${value.replace(/"/g, '""')}"` : value).join(this.metadata.delimiter);
    const bytes = Buffer.from((bom ? '\ufeff' : '') + text + this.metadata.newline);
    if (bytes.length > RECORD_LIMIT) throw new Error('A CSV record exceeds 16 MB.');
    return bytes;
  }

  private async checkpoint(): Promise<string> {
    if (this.historyBytes + this.metadata.bytes * 2 > HISTORY_DISK_LIMIT) throw new Error('Undo snapshots exceed the 2 GB disk budget. Save changes before another batch edit.');
    if (!this.structuralChanges && !this.rowChanges) {
      this.rowChanges = new Map();
      const rows = new Set([...this.baseModified.keys(), ...this.patches.keys(), ...[...this.textPatches.keys()].map(record => record - (this.metadata.hasHeader ? 1 : 0))]);
      for (const row of rows) await this.refreshRowBaseline(row, false);
    }
    const token = randomUUID(), path = await this.temporaryPath();
    await this.writeFile(path, { edits: true, sort: false, filters: false }, true);
    this.historyBytes += (await stat(path)).size;
    const modified = new Map([...this.baseModified].map(([row, columns]) => [row, [...columns]]));
    if (this.structuralChanges) {
      for (const [row, patches] of this.patches) modified.set(row, [...new Set([...(modified.get(row) ?? []), ...patches.keys()])]);
      for (const record of this.textPatches.keys()) {
        const row = record - (this.metadata.hasHeader ? 1 : 0);
        if (row < 0) continue;
        const values = await this.values(row), source = this.parseValues(await this.sourceRaw(row), row);
        modified.set(row, [...new Set([...(modified.get(row) ?? []), ...values.map((value, col) => value !== source[col] ? col : -1).filter(col => col >= 0)])]);
      }
    }
    this.checkpoints.set(token, { path, changes: this.changes, modified, format: { encoding: this.format.encoding, delimiter: this.metadata.delimiter }, hasHeader: this.metadata.hasHeader, structural: this.structuralChanges, rowChanges: this.rowChanges ? new Map(this.rowChanges) : undefined, modifiedHeaders: [...this.modifiedHeaders], headerBaseline: this.headerBaseline ? [...this.headerBaseline] : undefined, insertedRows: this.insertedRows.map(range => ({ ...range })), insertedColumns: [...this.addedColumns] });
    return token;
  }

  private async adopt(checkpoint: Checkpoint, query: Query, pins: number[] = []): Promise<Metadata> {
    await this.closeHandle();
    this.resetState(); this.path = checkpoint.path; this.format = checkpoint.format;
    this.metadata.hasHeader = checkpoint.hasHeader;
    this.modifiedHeaders = [...(checkpoint.modifiedHeaders ?? [])];
    this.headerBaseline = checkpoint.headerBaseline ? [...checkpoint.headerBaseline] : undefined;
    this.baseChanges = checkpoint.changes; this.baseModified = new Map(checkpoint.modified);
    this.structuralChanges = checkpoint.structural;
    this.insertedRows = (checkpoint.insertedRows ?? []).map(range => ({ ...range }));
    this.addedColumns = [...(checkpoint.insertedColumns ?? [])];
    this.rowChanges = checkpoint.rowChanges ? new Map(checkpoint.rowChanges) : undefined;
    await this.open(); await this.ready(); this.rowPins = [...pins];
    await this.query(query);
    return this.snapshot();
  }

  async restore(token: string): Promise<ChangeResult> {
    const checkpoint = this.checkpoints.get(token);
    if (!checkpoint) throw new Error('This undo version is no longer available.');
    const metadata = await this.adopt(checkpoint, checkpoint.viewState?.query ?? { filters: [], sort: null }, checkpoint.viewState?.pins ?? []);
    return { before: token, after: token, changes: this.changes, metadata };
  }

  async change(operation: ChangeOperation): Promise<ChangeResult> {
    await this.ready(); await this.checkVersion();
    if (this.queryDirty) await this.query(this.currentQuery);
    const query = this.currentQuery, pins = [...this.rowPins];
    const structure = ['insertRows', 'deleteRows', 'moveRow', 'moveColumn', 'insertColumn', 'deleteColumns'].includes(operation.kind);
    const columns = this.metadata.headers.length;
    const edits = new Map<number, Map<number, string>>();
    let editBytes = 0;
    const addEdit = (row: number, col: number, value: string) => {
      if (!Number.isSafeInteger(row) || row < 0 || !Number.isInteger(col) || col < 0 || col >= columns || typeof value !== 'string') throw new Error('Cell coordinates are outside the file.');
      editBytes += value.length * 2 + 80;
      if (editBytes > MEMORY_LIMIT) throw new Error('Batch edits exceed the 64 MB memory budget.');
      if (!edits.has(row)) edits.set(row, new Map());
      edits.get(row)!.set(col, value);
    };
    let insertedRows = 0, insertAt = this.metadata.rows;
    let deletedRows = new Set<number>(), deletedColumns = new Set<number>();
    let selectedRows: Set<number> | undefined, selectedColumns: Set<number> | undefined;
    let selectedCells: Map<number, Set<number>> | undefined;
    let regex: RE2JS | undefined;
    if (operation.kind === 'cells') {
      if (operation.edits.length > 100000) throw new Error('Paste or edit up to 100,000 cells at once.');
      for (const edit of operation.edits) { if (edit.row >= this.metadata.rows) throw new Error('Row is outside the file.'); addEdit(edit.row, edit.col, edit.value); }
    } else if (operation.kind === 'paste') {
      const targetColumns = this.validateColumns(operation.columns);
      const total = this.view?.length ?? this.metadata.rows;
      if (!Number.isSafeInteger(operation.row) || operation.row < 0 || operation.row > total) throw new Error('Paste starts outside the table.');
      if (Buffer.byteLength(operation.text) > 8 * 1024 * 1024) throw new Error('Paste up to 8 MB at once.');
      const rows = operation.text === '' ? [['']] : parseRecord(operation.text, { delimiter: '\t', relax_column_count: true, max_record_size: RECORD_LIMIT }) as string[][];
      if (rows.reduce((sum, row) => sum + row.length, 0) > 100000) throw new Error('Paste up to 100,000 cells at once.');
      if (rows.some(row => row.length > targetColumns.length)) throw new Error('Not enough destination columns. Insert more columns before pasting.');
      if (this.view && operation.row + rows.length > total) throw new Error('Clear sorting and filters before pasting beyond the last row.');
      for (let index = 0; index < rows.length; index++) {
        const row = this.rowAtView(operation.row + index);
        for (let col = 0; col < rows[index].length; col++) addEdit(row, targetColumns[col], rows[index][col]);
      }
      insertedRows = Math.max(0, operation.row + rows.length - this.metadata.rows);
    } else if (operation.kind === 'fill') {
      if (Buffer.byteLength(operation.value) > RECORD_LIMIT) throw new Error('The fill value exceeds 16 MB.');
      const groups = this.sparseCells(operation.selection);
      if (groups) {
        selectedRows = new Set(); selectedColumns = new Set();
        for (const [index, columns] of groups) for (const col of columns) addEdit(this.rowAtView(index), col, operation.value);
      } else { selectedRows = this.selectionRows(operation.selection); selectedColumns = new Set(operation.selection.columns); }
    } else if (operation.kind === 'replace') {
      regex = this.matcher(operation.search); selectedColumns = new Set(this.validateColumns(operation.search.columns));
      if (operation.selection) {
        const groups = this.sparseCells(operation.selection);
        if (groups) { selectedCells = new Map([...groups].map(([index, columns]) => [this.rowAtView(index), columns])); selectedRows = new Set(selectedCells.keys()); }
        else selectedRows = this.selectionRows(operation.selection);
        selectedColumns = new Set([...selectedColumns].filter(col => operation.selection!.columns.includes(col)));
      }
      if (Buffer.byteLength(operation.replacement) > RECORD_LIMIT) throw new Error('The replacement exceeds 16 MB.');
    } else if (operation.kind === 'insertRows') {
      if (!columns) throw new Error('Insert a column before adding rows to an empty file.');
      if (!Number.isSafeInteger(operation.at) || operation.at < 0 || operation.at > this.metadata.rows || !Number.isSafeInteger(operation.count) || operation.count < 1 || operation.count > 100000) throw new Error('Insert between 1 and 100,000 rows at a valid position.');
      insertAt = operation.at; insertedRows = operation.count;
    } else if (operation.kind === 'deleteRows') {
      if (!operation.rows.length || operation.rows.length > 1000000 || operation.rows.some(row => !Number.isSafeInteger(row) || row < 0 || row >= this.metadata.rows)) throw new Error('Choose valid rows to delete.');
      deletedRows = new Set(operation.rows);
    } else if (operation.kind === 'moveRow') {
      if (query.sort || query.filters.length) throw new Error('Clear sorting and filters before moving rows.');
      if (!Number.isSafeInteger(operation.row) || operation.row < 0 || operation.row >= this.metadata.rows || !Number.isSafeInteger(operation.before) || operation.before < 0 || operation.before > this.metadata.rows) throw new Error('Choose a valid row and destination.');
      if (operation.row === operation.before || operation.row + 1 === operation.before) return { before: '', after: '', changes: this.changes, metadata: this.snapshot() };
    } else if (operation.kind === 'renameColumn') {
      if (!this.metadata.hasHeader) throw new Error('Enable a real header row before editing column names.');
      if (!Number.isInteger(operation.col) || operation.col < 0 || operation.col >= columns || typeof operation.name !== 'string' || operation.name.length > 65536) throw new Error('Choose a valid column name.');
      if (this.metadata.headers[operation.col] === operation.name) return { before: '', after: '', changes: this.changes, metadata: this.snapshot() };
    } else if (operation.kind === 'insertColumn') {
      if (!Number.isInteger(operation.at) || operation.at < 0 || operation.at > columns || operation.name.length > 65536) throw new Error('Choose a valid column position and name.');
    } else if (operation.kind === 'moveColumn') {
      if (!Number.isInteger(operation.col) || operation.col < 0 || operation.col >= columns || !Number.isInteger(operation.before) || operation.before < 0 || operation.before > columns) throw new Error('Choose a valid column and destination.');
      if (operation.col === operation.before || operation.col + 1 === operation.before) return { before: '', after: '', changes: this.changes, metadata: this.snapshot() };
    } else if (operation.kind === 'deleteColumns') {
      deletedColumns = new Set(this.validateColumns(operation.columns));
      if (deletedColumns.size === columns) throw new Error('Keep at least one column.');
    } else throw new Error('Unsupported change.');
    const before = await this.checkpoint(), outputPath = await this.temporaryPath();
    const output = await open(outputPath, 'wx');
    const baseline = !structure && !this.structuralChanges && !insertedRows ? await this.baseline() : undefined;
    const rowChanges = baseline ? new Map<number, number>() : undefined;
    let changes = operation.kind === 'renameColumn' || operation.kind === 'insertColumn' || operation.kind === 'deleteColumns' || operation.kind === 'moveRow' || operation.kind === 'moveColumn' ? 1 : 0, previousEnded = true, writtenRows = 0, modifiedBytes = 0, writtenBytes = 0, baselineChanges = 0, finalSuffix = 0;
    const modified = this.modifiedAfter(operation, this.checkpoints.get(before)!.modified);
    const write = async (bytes: Buffer) => {
      writtenBytes += bytes.length;
      if (writtenBytes + this.historyBytes > HISTORY_DISK_LIMIT) throw new Error('Undo snapshots exceed the 2 GB disk budget. Save changes before another batch edit.');
      if (!previousEnded) await output.write(Buffer.from(this.metadata.newline));
      let cursor = 0;
      while (cursor < bytes.length) cursor += (await output.write(bytes, cursor, bytes.length - cursor)).bytesWritten;
      previousEnded = bytes.at(-1) === 10 || bytes.at(-1) === 13;
      finalSuffix = bytes.at(-1) === 10 ? (bytes.at(-2) === 13 ? 2 : 1) : bytes.at(-1) === 13 ? 1 : 0;
    };
    const prefix = Buffer.alloc(Math.min(3, this.metadata.bytes));
    await this.handle!.read(prefix, 0, prefix.length, 0);
    const bom = prefix.equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const tail = Buffer.alloc(Math.min(2, this.metadata.bytes));
    await this.handle!.read(tail, 0, tail.length, this.metadata.bytes - tail.length);
    const trailing = tail.at(-1) === 10 || tail.at(-1) === 13;
    const remember = (row: number, cols: number[]) => {
      modifiedBytes += cols.length * 8 + 64;
      if (modifiedBytes > MEMORY_LIMIT) throw new Error('The batch changes too many cells. Save a smaller batch first.');
      modified.set(row, [...new Set([...(modified.get(row) ?? []), ...cols])]);
    };
    const transformColumns = (values: string[], header: boolean) => {
      if (operation.kind === 'insertColumn') { while (values.length < operation.at) values.push(''); values.splice(operation.at, 0, header ? operation.name : ''); }
      if (operation.kind === 'deleteColumns') values = values.filter((_, col) => !deletedColumns.has(col));
      return values;
    };
    try {
      if (!this.metadata.hasHeader && bom) await output.write(prefix);
      if (this.metadata.hasHeader && !this.records && operation.kind === 'insertColumn') await write(this.serialize([operation.name]));
      if (this.metadata.hasHeader && this.records) {
        let raw = await this.record(0);
        if (operation.kind === 'renameColumn') {
          const { bom, suffix, tokens } = this.tokenizeRecord(raw, true);
          const value = operation.name;
          tokens[operation.col] = value.includes(this.metadata.delimiter) || /["\r\n]/.test(value) || (tokens.length === 1 && value === '') ? `"${value.replace(/"/g, '""')}"` : value;
          raw = Buffer.from(bom + tokens.join(this.metadata.delimiter) + suffix);
          if (raw.length > RECORD_LIMIT) throw new Error('The edited CSV record exceeds 16 MB and cannot be saved.');
          if (baseline && tokens.every((_, col) => (col === operation.col ? operation.name : this.metadata.headers[col]) === baseline.metadata.headers[col])) raw = await baseline.record(0);
        }
        await write(operation.kind === 'moveColumn' ? this.movedColumn(raw, operation.col, operation.before, true) : operation.kind === 'insertColumn' || operation.kind === 'deleteColumns' ? this.serialize(transformColumns([...this.metadata.headers], true), raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) : raw);
        if (baseline && !(await baseline.record(0)).equals(raw)) { baselineChanges++; rowChanges!.set(-1, 1); }
      }
      const appendBlank = async (row: number) => {
        const values = Array.from({ length: columns }, () => '');
        for (const [col, value] of edits.get(row) ?? []) values[col] = value;
        await write(this.serialize(values));
        const edited = values.flatMap((value, col) => value !== '' ? [col] : []);
        if (edited.length) remember(writtenRows, edited);
        writtenRows++; changes++;
      };
      for (let row = 0; row <= this.metadata.rows; row++) {
        if (row === insertAt) for (let count = 0; count < insertedRows; count++) await appendBlank(row + count);
        if (row === this.metadata.rows) break;
        if (deletedRows.has(row)) { changes++; continue; }
        if (operation.kind === 'moveColumn') {
          let bytes = this.movedColumn(await this.record(row + (this.metadata.hasHeader ? 1 : 0)), operation.col, operation.before, !this.metadata.hasHeader && row === 0);
          if (!this.metadata.hasHeader && row === 0 && bom && bytes.subarray(0, 3).equals(prefix)) bytes = bytes.subarray(3);
          await write(bytes); writtenRows++;
          if (row % 4096 === 0) await new Promise<void>(done => setImmediate(done));
          continue;
        }
        if (operation.kind === 'moveRow') {
          const destination = operation.before > operation.row ? operation.before - 1 : operation.before;
          const source = row === destination ? operation.row : operation.row < destination && row >= operation.row && row < destination ? row + 1 : destination < operation.row && row > destination && row <= operation.row ? row - 1 : row;
          let bytes = await this.record(source + (this.metadata.hasHeader ? 1 : 0));
          if (!this.metadata.hasHeader && source === 0 && bom && bytes.subarray(0, 3).equals(prefix)) bytes = bytes.subarray(3);
          await write(bytes); writtenRows++;
          if (row % 4096 === 0) await new Promise<void>(done => setImmediate(done));
          continue;
        }
        const values = await this.values(row), changed: number[] = [];
        const set = (col: number, value: string) => { if ((values[col] ?? '') !== value) { while (values.length <= col) values.push(''); values[col] = value; changed.push(col); changes++; } };
        for (const [col, value] of edits.get(row) ?? []) set(col, value);
        if (!selectedRows || selectedRows.has(row)) {
          if (operation.kind === 'fill') for (const col of selectedColumns!) set(col, operation.value);
          if (operation.kind === 'replace') for (const col of selectedColumns!) {
            if (selectedCells && !selectedCells.get(row)?.has(col)) continue;
            const value = values[col] ?? ''; this.regexValue(operation.search, value);
            set(col, this.replaceValue(regex!, value, operation.replacement, !operation.search.regex));
          }
        }
        let bytes: Buffer;
        if (operation.kind === 'insertColumn' || operation.kind === 'deleteColumns') {
          bytes = this.serialize(transformColumns(values, false)); changes++;
        } else if (changed.length) {
          const raw = await this.raw(row), patches = new Map(this.patches.get(row));
          for (const col of changed) patches.set(col, { original: '', value: values[col] });
          bytes = this.modified(raw, patches, row); remember(writtenRows, changed);
        } else bytes = await this.record(row + (this.metadata.hasHeader ? 1 : 0));
        if (baseline) {
          const original = await baseline.values(row), originalBytes = await baseline.record(row + (this.metadata.hasHeader ? 1 : 0));
          const differences = Array.from({ length: Math.max(values.length, original.length) }, (_, col) => col).filter(col => (values[col] ?? '') !== (original[col] ?? ''));
          if (!differences.length && changed.length) bytes = originalBytes;
          baselineChanges += differences.length || (bytes.equals(originalBytes) ? 0 : 1);
          const dirty = differences.length || (bytes.equals(originalBytes) ? 0 : 1);
          if (dirty) rowChanges!.set(row, dirty);
          if (differences.length) modified.set(row, differences); else modified.delete(row);
        }
        if (!this.metadata.hasHeader && row === 0 && bom && bytes.subarray(0, 3).equals(prefix)) bytes = bytes.subarray(3);
        await write(bytes);
        writtenRows++;
        if (row % 4096 === 0) await new Promise<void>(done => setImmediate(done));
      }
      if (!trailing) {
        const current = await output.stat();
        if (finalSuffix && current.size) {
          // Keep at least one field in the last record; serialize quotes an empty field.
          await output.truncate(current.size - finalSuffix);
        }
      }
      await output.sync(); await output.close();
      if (!changes) {
        await unlink(outputPath);
        const unused = this.checkpoints.get(before)!; this.historyBytes -= (await stat(unused.path)).size;
        await unlink(unused.path); this.checkpoints.delete(before);
        return { before, after: before, changes: this.changes, metadata: this.snapshot() };
      }
      this.historyBytes += (await stat(outputPath)).size;
      const checkpoint: Checkpoint = { path: outputPath, changes: baseline ? baselineChanges : this.changes + changes, modified, format: { encoding: this.format.encoding, delimiter: this.metadata.delimiter }, hasHeader: this.metadata.hasHeader, structural: structure || this.structuralChanges || insertedRows > 0, rowChanges };
      checkpoint.insertedRows = this.insertedRowsAfter(operation, insertedRows, insertAt);
      checkpoint.insertedColumns = this.insertedColumnsAfter(operation);
      checkpoint.modifiedHeaders = [...this.modifiedHeaders];
      checkpoint.headerBaseline = this.headerBaseline ? [...this.headerBaseline] : undefined;
      if (operation.kind === 'moveColumn' || operation.kind === 'insertColumn' || operation.kind === 'deleteColumns') {
        const names = [...(this.headerBaseline ?? this.metadata.headers)];
        const dirty = new Set(this.modifiedHeaders);
        if (operation.kind === 'moveColumn') {
          const indices = names.map((_, col) => col), [moved] = indices.splice(operation.col, 1);
          indices.splice(operation.before > operation.col ? operation.before - 1 : operation.before, 0, moved);
          checkpoint.headerBaseline = indices.map(col => names[col]);
          checkpoint.modifiedHeaders = indices.flatMap((col, index) => dirty.has(col) ? [index] : []);
        } else if (operation.kind === 'insertColumn') {
          names.splice(operation.at, 0, operation.name); checkpoint.headerBaseline = names;
          checkpoint.modifiedHeaders = this.modifiedHeaders.map(col => col >= operation.at ? col + 1 : col);
        } else {
          const indices = names.map((_, col) => col).filter(col => !deletedColumns.has(col));
          checkpoint.headerBaseline = indices.map(col => names[col]);
          checkpoint.modifiedHeaders = indices.flatMap((col, index) => dirty.has(col) ? [index] : []);
        }
      }
      if (operation.kind === 'renameColumn') {
        const original = this.headerBaseline ?? (this.structuralChanges ? this.metadata.headers : (await this.baseline()).metadata.headers);
        checkpoint.headerBaseline = [...original];
        const names = [...this.metadata.headers]; names[operation.col] = operation.name;
        checkpoint.modifiedHeaders = names.flatMap((name, col) => name !== original[col] ? [col] : []);
        const viewState = { query, pins };
        this.checkpoints.get(before)!.viewState = viewState;
        checkpoint.viewState = viewState;
      }
      const after = randomUUID(); this.checkpoints.set(after, checkpoint);
      try {
        const metadata = await this.adopt(checkpoint, structure ? { filters: [], sort: null } : query, structure ? [] : pins);
        return { before, after, changes: this.changes, metadata };
      } catch (error) { this.checkpoints.delete(after); await this.adopt(this.checkpoints.get(before)!, query, pins); throw error; }
    } catch (error) {
      await output.close().catch(() => undefined); await unlink(outputPath).catch(() => undefined); throw error;
    }
  }

  private insertedColumnsAfter(operation: ChangeOperation): number[] {
    if (operation.kind === 'insertColumn') return [...this.addedColumns.map(col => col >= operation.at ? col + 1 : col), operation.at].sort((a, b) => a - b);
    if (operation.kind === 'deleteColumns') {
      const deleted = [...new Set(operation.columns)].sort((a, b) => a - b);
      return this.addedColumns.filter(col => !deleted.includes(col)).map(col => col - deleted.filter(removed => removed < col).length);
    }
    if (operation.kind === 'moveColumn') {
      const destination = operation.before > operation.col ? operation.before - 1 : operation.before;
      return this.addedColumns.map(col => col === operation.col ? destination : operation.col < destination && col > operation.col && col <= destination ? col - 1 : destination < operation.col && col >= destination && col < operation.col ? col + 1 : col).sort((a, b) => a - b);
    }
    return [...this.addedColumns];
  }

  private modifiedAfter(operation: ChangeOperation, source: Map<number, number[]>): Map<number, number[]> {
    const removed = operation.kind === 'deleteRows' ? operation.rows : operation.kind === 'deleteColumns' ? operation.columns : [];
    const deleted = [...new Set(removed)].sort((a, b) => a - b), deletedSet = new Set(deleted);
    const before = (index: number) => {
      let low = 0, high = deleted.length;
      while (low < high) { const mid = (low + high) >>> 1; if (deleted[mid] < index) low = mid + 1; else high = mid; }
      return low;
    };
    const modified = new Map<number, number[]>();
    for (const [row, columns] of source) {
      if (operation.kind === 'deleteRows' && deletedSet.has(row)) continue;
      const nextRow = operation.kind === 'moveRow' ? this.movedRowIndex(row, operation)
        : operation.kind === 'insertRows' && row >= operation.at ? row + operation.count
        : operation.kind === 'deleteRows' ? row - before(row) : row;
      const nextColumns = columns.flatMap(col => {
        if (operation.kind === 'deleteColumns') return deletedSet.has(col) ? [] : [col - before(col)];
        if (operation.kind === 'insertColumn') return [col >= operation.at ? col + 1 : col];
        if (operation.kind === 'moveColumn') {
          const destination = operation.before > operation.col ? operation.before - 1 : operation.before;
          return [col === operation.col ? destination : operation.col < destination && col > operation.col && col <= destination ? col - 1 : destination < operation.col && col >= destination && col < operation.col ? col + 1 : col];
        }
        return [col];
      });
      if (nextColumns.length) modified.set(nextRow, nextColumns);
    }
    return modified;
  }

  private mapRowRanges(source: RowRange[], operation: ChangeOperation): RowRange[] {
    let ranges = source.map(range => ({ ...range }));
    if (operation.kind === 'moveRow') {
      const destination = this.movedRowIndex(operation.row, operation);
      const cuts = [...new Set([operation.row, operation.row + 1, destination, destination + 1])].sort((a, b) => a - b);
      ranges = ranges.flatMap(range => {
        const points = [range.start, ...cuts.filter(point => point > range.start && point < range.start + range.count), range.start + range.count];
        return points.slice(0, -1).map((point, index) => ({ start: this.movedRowIndex(point, operation), count: points[index + 1] - point }));
      });
    } else if (operation.kind === 'insertRows') {
      ranges = ranges.flatMap(range => {
        const end = range.start + range.count;
        if (end <= operation.at) return [range];
        if (range.start >= operation.at) return [{ start: range.start + operation.count, count: range.count }];
        return [{ start: range.start, count: operation.at - range.start }, { start: operation.at + operation.count, count: end - operation.at }];
      });
    } else if (operation.kind === 'deleteRows') {
      const deleted = [...new Set(operation.rows)].sort((a, b) => a - b);
      const before = (row: number) => {
        let low = 0, high = deleted.length;
        while (low < high) { const mid = (low + high) >>> 1; if (deleted[mid] < row) low = mid + 1; else high = mid; }
        return low;
      };
      ranges = ranges.map(range => {
        const start = range.start - before(range.start), end = range.start + range.count;
        return { start, count: end - before(end) - start };
      }).filter(range => range.count > 0);
    }
    return this.mergeRanges(ranges);
  }

  private mergeRanges(ranges: RowRange[]): RowRange[] {
    const merged: RowRange[] = [];
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.start + previous.count) previous.count = Math.max(previous.start + previous.count, range.start + range.count) - previous.start;
      else merged.push(range);
    }
    return merged;
  }

  private movedRowIndex(row: number, operation: Extract<ChangeOperation, { kind: 'moveRow' }>): number {
    const destination = operation.before > operation.row ? operation.before - 1 : operation.before;
    return row === operation.row ? destination : operation.row < destination && row > operation.row && row <= destination ? row - 1 : destination < operation.row && row >= destination && row < operation.row ? row + 1 : row;
  }

  private insertedRowsAfter(operation: ChangeOperation, added: number, at: number): RowRange[] {
    let inserted = this.mapRowRanges(this.insertedRows, operation);
    if (added) {
      if (operation.kind !== 'insertRows') inserted = this.mapRowRanges(inserted, { kind: 'insertRows', at, count: added });
      inserted.push({ start: at, count: added });
    }
    return this.mergeRanges(inserted);
  }

  private async checkVersion(): Promise<void> {
    const current = await stat(this.path);
    if (!this.version || current.size !== this.version.size || current.mtimeMs !== this.version.mtimeMs || current.ctimeMs !== this.version.ctimeMs || current.ino !== this.version.ino) throw new Error('The file changed on disk. Reload it or use Save As.');
    const source = await stat(this.sourcePath);
    if (!this.sourceVersion || source.size !== this.sourceVersion.size || source.mtimeMs !== this.sourceVersion.mtimeMs || source.ctimeMs !== this.sourceVersion.ctimeMs || source.ino !== this.sourceVersion.ino) throw new Error('The file changed on disk. Reload it or use Save As.');
  }

  async save(target?: string, options: SaveOptions = { edits: true, sort: false, filters: false }): Promise<Metadata | null> {
    if (options.encoding && !iconv.encodingExists(options.encoding)) throw new Error('Unsupported output encoding.');
    if (options.columns !== undefined) {
      const source = await stat(this.sourcePath), destination = target ? await stat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; }) : undefined;
      if (!target || resolve(target) === resolve(this.sourcePath) || (destination && source.ino === destination.ino && source.dev === destination.dev)) throw new Error('Choose a different file for exporting the current view.');
    }
    const pins = [...this.rowPins];
    await this.writeFile(target ?? this.sourcePath, options);
    if (resolve(target ?? this.sourcePath) !== resolve(this.sourcePath)) return null;
    if (options.encoding) this.format.encoding = options.encoding;
    await this.reload();
    if (options.edits && !options.sort && !options.filters) this.rowPins = pins;
    return this.snapshot();
  }

  private async writeFile(destination: string, options: SaveOptions = { edits: true, sort: false, filters: false }, utf8 = false): Promise<void> {
    await this.scanning;
    this.assertHealthy();
    await this.checkVersion();
    if (!options.edits && (this.baseChanges || this.path !== this.sourcePath)) {
      if (this.baseChanges && (options.sort || options.filters || options.columns !== undefined)) throw new Error('Save content changes together with view transformations after batch or structural edits.');
      const original = new CsvFile(this.sourcePath, undefined, undefined, { hasHeader: this.metadata.hasHeader, format: this.format });
      try {
        await original.open(); await original.scanning;
        await original.query({ filters: options.filters ? this.currentQuery.filters : [], sort: options.sort ? this.currentQuery.sort : null });
        await original.writeFile(destination, { ...options, edits: true }, utf8);
      } finally { await original.dispose(); }
      return;
    }
    const temp = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
    let output: FileHandle | undefined;
    const previousView = this.view, previousQuery = this.currentQuery, previousDirty = this.queryDirty;
    const columns = options.columns === undefined ? undefined : this.validateColumns(options.columns).slice().sort((a, b) => a - b);
    const transformed = options.sort || options.filters || columns !== undefined;
    try {
      if (transformed) await this.query({ filters: options.filters ? previousQuery.filters : [], sort: options.sort ? previousQuery.sort : null });
      output = await open(temp, 'wx', (await this.handle!.stat()).mode);
      let cursor = 0;
      const buffer = Buffer.alloc(1024 * 1024);
      const write = async (bytes: Buffer) => {
        let position = 0;
        while (position < bytes.length) position += (await output!.write(bytes, position, bytes.length - position)).bytesWritten;
      };
      const copy = async (until: number) => {
        while (cursor < until) {
          const { bytesRead } = await this.handle!.read(buffer, 0, Math.min(buffer.length, until - cursor), cursor);
          if (!bytesRead) throw new Error('The file contents changed. Reload the file.');
          await write(buffer.subarray(0, bytesRead));
          cursor += bytesRead;
        }
      };
      if (transformed) {
        const prefix = Buffer.alloc(Math.min(3, this.metadata.bytes));
        await this.handle!.read(prefix, 0, prefix.length, 0);
        const bom = prefix.equals(Buffer.from([0xef, 0xbb, 0xbf]));
        if (this.metadata.hasHeader && this.records) {
          const raw = await this.record(0, options.edits);
          await write(columns ? this.projectRecord(raw, columns, true) : raw);
        }
        else if (bom) await write(prefix);
        const tail = Buffer.alloc(Math.min(2, this.metadata.bytes));
        await this.handle!.read(tail, 0, tail.length, this.metadata.bytes - tail.length);
        const trailing = tail.at(-1) === 10 || tail.at(-1) === 13;
        const count = this.view?.length ?? this.metadata.rows;
        const newline = Buffer.from(this.metadata.newline);
        const batch = Buffer.alloc(READ_BLOCK);
        let used = 0;
        const append = async (bytes: Buffer) => {
          if (used + bytes.length > batch.length) { await write(batch.subarray(0, used)); used = 0; }
          if (bytes.length > batch.length) await write(bytes);
          else { bytes.copy(batch, used); used += bytes.length; }
        };
        for (let index = 0; index < count; index++) {
          const row = this.view ? this.view[index] : index;
          let bytes = await this.record(row + (this.metadata.hasHeader ? 1 : 0), options.edits);
          if (columns) bytes = this.projectRecord(bytes, columns, !this.metadata.hasHeader && row === 0);
          if (!this.metadata.hasHeader && row === 0 && bom) bytes = bytes.subarray(3);
          const suffix = bytes.at(-1) === 10 ? (bytes.at(-2) === 13 ? 2 : 1) : bytes.at(-1) === 13 ? 1 : 0;
          const record = suffix ? bytes.subarray(0, -suffix) : bytes;
          // Preserve an empty final record as a quoted field when there is no trailing newline.
          await append(record.length ? record : Buffer.from('""'));
          if (index + 1 < count || trailing) await append(newline);
        }
        if (used) await write(batch.subarray(0, used));
      } else {
        const records = new Set([...this.textPatches.keys(), ...[...this.patches.keys()].map(row => row + (this.metadata.hasHeader ? 1 : 0))]);
        if (options.edits) for (const record of [...records].sort((a, b) => a - b)) {
          await copy(record === 0 ? 0 : this.end(record - 1));
          await write(await this.record(record));
          cursor = this.end(record);
        }
        await copy(this.metadata.bytes);
      }
      await output.sync();
      await output.close();
      output = undefined;
      await this.checkVersion();
      const outputEncoding = options.encoding ?? this.format.encoding;
      if (!utf8 && !['utf8', 'utf-8'].includes(outputEncoding.toLowerCase())) {
        const encoded = `${temp}.encoded`;
        try {
          const encoding = outputEncoding;
          const streamEncoder = iconv.getEncoder(encoding);
          const encoder = new Transform({ decodeStrings: false, transform(chunk: string, _encoding, callback) {
            const bytes = iconv.encode(chunk, encoding);
            if (iconv.decode(bytes, encoding, { stripBOM: false }) !== chunk) return callback(new Error(`Some characters cannot be saved as ${encoding}. Save as UTF-8 instead.`));
            callback(null, streamEncoder.write(chunk));
          }, flush(callback) { callback(null, streamEncoder.end()); } });
          await pipeline(createReadStream(temp), iconv.decodeStream('utf8', { stripBOM: false }), encoder, createWriteStream(encoded, { flags: 'wx' }));
          const encodedHandle = await open(encoded, 'r+');
          try { await encodedHandle.sync(); } finally { await encodedHandle.close(); }
          await rename(encoded, destination);
        } finally { await unlink(encoded).catch(() => undefined); await unlink(temp).catch(() => undefined); }
      } else await rename(temp, destination);
    } catch (error) {
      await output?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    finally { this.view = previousView; this.currentQuery = previousQuery; this.queryDirty = previousDirty; this.rebuildRowPins(); }
  }

  async reload(): Promise<Metadata> {
    await this.dispose();
    this.path = this.sourcePath; this.sourceVersion = undefined;
    this.modifiedHeaders = []; this.headerBaseline = undefined;
    this.baseChanges = 0; this.baseModified.clear(); this.structuralChanges = false; this.addedColumns = []; this.insertedRows = [];
    this.rowChanges = undefined;
    this.resetState();
    return this.open();
  }

  private resetState(): void {
    this.offsets = [];
    this.records = 0;
    this.patches.clear();
    this.patchBytes = 0;
    this.textPatches.clear(); this.textBytes = 0; this.textRevision++;
    this.view = null;
    this.rowPins = []; this.visiblePins = []; this.pinnedIndices = [];
    this.currentQuery = { filters: [], sort: null }; this.queryDirty = false;
    this.failure = undefined;
    this.metadata = { headers: [], rows: 0, bytes: 0, scanned: 0, complete: false, delimiter: ',', newline: '\n', hasHeader: this.metadata.hasHeader };
  }

  private async closeHandle(): Promise<void> {
    this.generation++;
    this.revision++;
    this.stream?.destroy();
    await this.scanning;
    await this.handle?.close();
    this.handle = undefined;
    this.readAhead = undefined;
    this.lastReadRow = undefined;
  }

  async dispose(): Promise<void> {
    await this.closeHandle();
    await this.baselineFile?.dispose(); this.baselineFile = undefined;
    if (this.temporaryDirectory) await rm(this.temporaryDirectory, { recursive: true, force: true });
    this.temporaryDirectory = undefined; this.checkpoints.clear(); this.historyBytes = 0;
  }
}
