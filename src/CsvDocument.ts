/*
File purpose: Own CSV edit history, save transactions, and the engine worker lifecycle.
*/
import { t } from './Locale';
import * as vscode from 'vscode';
import { stat, copyFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VersionHistory } from './VersionHistory';
import { EngineClient } from './EngineClient';
import type { CellEdit, HostMessage, Metadata, Query, SaveOptions, SaveChoice, SaveDecision, TextPage, TextEdit, TextEditResult, FileFormat, ChangeOperation, ChangeResult } from './protocol';

type TextState = { start: number; count: number; valid: string; cells?: CellEdit[]; draft?: { text: string; error: string } };

export class CsvDocument implements vscode.CustomDocument {
  private readonly disposeEvent = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEvent.event;
  readonly engine: EngineClient;
  private tail: Promise<unknown> = Promise.resolve();
  private dirty = 0;
  textDraft?: { start: number; count: number; text: string; error: string };
  private fingerprint = '';
  private sourcePath: string;
  private restored = false;
  private scanWaiter?: { resolve: () => void; reject: (error: Error) => void };
  private historyCursor = 0;
  private historyLength = 0;
  private historyGeneration = 0;
  metadata?: Metadata;
  lastError?: string;
  query: Query = { filters: [], sort: null };
  format: FileFormat = { encoding: 'utf8' };
  nextSave?: SaveChoice;
  chooseSave: (saveAs: boolean, allowDiscard?: boolean) => Promise<SaveDecision | null> = async () => null;
  notify: (message: HostMessage) => void = () => {};
  onEdit: (event: vscode.CustomDocumentEditEvent<CsvDocument>) => void = () => {};

  private constructor(readonly uri: vscode.Uri, workerPath: string) {
    this.sourcePath = uri.fsPath;
    this.engine = new EngineClient(workerPath);
    this.engine.onMetadata = data => {
      this.metadata = { ...data, encoding: this.format.encoding };
      if (data.headers.length || data.complete) this.notify({ type: 'metadata', data: this.metadata });
      if (data.complete) { this.scanWaiter?.resolve(); this.scanWaiter = undefined; }
    };
    this.engine.onError = error => {
      this.lastError = error.message;
      this.scanWaiter?.reject(error);
      this.scanWaiter = undefined;
      this.notify({ type: 'error', message: error.message });
    };
  }

  static async open(uri: vscode.Uri, workerPath: string, backupId?: string, hasHeader = true, format?: FileFormat): Promise<CsvDocument> {
    if (uri.scheme !== 'file') throw new Error(t('Neat CSV currently supports local files only.'));
    const doc = new CsvDocument(uri, workerPath);
    try {
      const backup = backupId ? JSON.parse(backupId) as { uri: string; fingerprint: string; hasHeader?: boolean; format?: FileFormat; outputEncoding?: string; textDraft?: CsvDocument['textDraft'] } : undefined;
      doc.fingerprint = backup ? backup.fingerprint : await doc.diskFingerprint();
      doc.restored = !!backup;
      doc.textDraft = backup?.textDraft;
      doc.sourcePath = backup ? vscode.Uri.parse(backup.uri).fsPath : uri.fsPath;
      const sourceFormat = backup?.format ?? format ?? doc.format;
      doc.format = { ...sourceFormat, encoding: backup?.outputEncoding ?? sourceFormat.encoding };
      doc.acceptSnapshot(await doc.engine.request({ method: 'open', path: doc.sourcePath, hasHeader: backup?.hasHeader ?? hasHeader, format: sourceFormat }) as Metadata);
      return doc;
    } catch (error) { doc.dispose(); throw error; }
  }

  get changes(): number {
    return this.dirty + (this.textDraft ? 1 : 0) + (this.restored ? 1 : 0);
  }

  header(enabled: boolean): Promise<Metadata> {
    return this.run(async () => {
      if (this.changes) throw new Error(t('Save your changes before changing the header setting.'));
      this.lastError = undefined;
      this.metadata = undefined;
      this.query = { filters: [], sort: null };
      this.acceptSnapshot(await this.engine.request({ method: 'open', path: this.sourcePath, hasHeader: enabled, format: this.format }) as Metadata);
      this.dirty = 0; this.textDraft = undefined;
      this.historyCursor = this.historyLength = 0;
      this.historyGeneration++;
      this.notifyChanged();
      return this.metadata!;
    });
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  configure(format: FileFormat): Promise<Metadata> {
    return this.run(async () => {
      if (this.changes) throw new Error(t('Save your changes before changing the encoding or delimiter.'));
      let data: Metadata;
      try { data = await this.engine.request({ method: 'configure', format }) as Metadata; }
      catch (error) { this.lastError = undefined; throw error; }
      this.lastError = undefined;
      this.format = format;
      this.metadata = data;
      this.query = { filters: [], sort: null };
      this.historyCursor = this.historyLength = 0; this.historyGeneration++;
      this.acceptSnapshot(data);
      this.notify({ type: 'viewReset' }); this.notifyChanged();
      return data;
    });
  }

  change(operation: ChangeOperation): Promise<ChangeResult> {
    return this.run(async () => {
      if (this.textDraft) throw new Error(t('Fix the CSV syntax in Text before changing the table.'));
      const result = await this.engine.request({ method: 'change', operation }) as ChangeResult;
      if (result.before === result.after) return result;
      this.dirty = result.changes;
      this.metadata = result.metadata;
      this.acceptSnapshot(result.metadata);
      this.historyLength = ++this.historyCursor;
      const generation = this.historyGeneration;
      const structural = ['insertRows', 'deleteRows', 'insertColumn', 'deleteColumns', 'moveRow', 'moveColumn'].includes(operation.kind);
      if (structural) { this.query = { filters: [], sort: null }; this.notify({ type: 'viewReset' }); }
      this.onEdit({ document: this, label: t(operation.kind === 'replace' ? 'Replace CSV values' : 'Change CSV data'),
        undo: () => generation === this.historyGeneration ? this.restoreChange(result.before, -1, operation.kind !== 'renameColumn') : Promise.resolve(),
        redo: () => generation === this.historyGeneration ? this.restoreChange(result.after, 1, operation.kind !== 'renameColumn') : Promise.resolve(),
      });
      this.notifyChanged();
      return result;
    });
  }

  private restoreChange(token: string, direction: 1 | -1, resetView: boolean): Promise<void> {
    return this.run(async () => {
      const result = await this.engine.request({ method: 'restore', token }) as ChangeResult;
      this.dirty = result.changes;
      this.metadata = result.metadata; this.acceptSnapshot(result.metadata);
      if (resetView) this.query = { filters: [], sort: null };
      this.historyCursor += direction;
      if (resetView) this.notify({ type: 'viewReset' });
      this.notifyChanged();
    });
  }

  edit(edit: CellEdit): Promise<void> {
    return this.run(async () => {
      const result = await this.engine.request({ method: 'edit', edit }) as { value: string; changes: number };
      const before = result.value;
      if (before === edit.value) return;
      this.dirty = result.changes;
      this.historyLength = ++this.historyCursor;
      const generation = this.historyGeneration;
      this.onEdit({
        document: this, label: t('Edit CSV cell'),
        undo: () => generation === this.historyGeneration ? this.apply({ ...edit, value: before }, -1) : Promise.resolve(),
        redo: () => generation === this.historyGeneration ? this.apply(edit, 1) : Promise.resolve(),
      });
      this.notifyChanged();
    });
  }

  private apply(edit: CellEdit, direction: 1 | -1): Promise<void> {
    return this.run(async () => {
      const result = await this.engine.request({ method: 'edit', edit }) as { value: string; changes: number };
      this.dirty = result.changes;
      this.historyCursor += direction;
      this.notifyChanged();
    });
  }

  textPage(start: number, count: number): Promise<TextPage> {
    return this.run(async () => {
      const page = await this.engine.request({ method: 'textPage', start, count: this.textDraft?.start === start ? this.textDraft.count : count }) as TextPage;
      return this.textDraft?.start === start ? { ...page, text: this.textDraft.text, draftError: this.textDraft.error } : page;
    });
  }

  textEdit(edit: TextEdit): Promise<TextEditResult> {
    return this.run(async () => {
      const previousDraft = this.textDraft;
      if (previousDraft && previousDraft.start !== edit.start) throw new Error(t('Fix the current text section before opening another section.'));
      const result = await this.engine.request({ method: 'textEdit', edit }) as TextEditResult;
      const before: TextState = { start: edit.start, count: edit.count, valid: result.beforeState?.text ?? result.before, cells: result.beforeState?.cells,
        ...(previousDraft ? { draft: { text: previousDraft.text, error: previousDraft.error } } : {}) };
      const after: TextState = { start: edit.start, count: edit.count, valid: result.error ? result.before : result.page.text,
        ...(result.error ? { draft: { text: edit.text, error: result.error } } : {}) };
      this.dirty = result.changes;
      this.textDraft = after.draft ? { start: edit.start, count: edit.count, ...after.draft } : undefined;
      if ((before.draft?.text ?? before.valid) !== (after.draft?.text ?? after.valid)) {
        this.historyLength = ++this.historyCursor;
        const generation = this.historyGeneration;
        this.onEdit({ document: this, label: t('Edit CSV text'),
          undo: () => generation === this.historyGeneration ? this.restoreText(before, -1) : Promise.resolve(),
          redo: () => generation === this.historyGeneration ? this.restoreText(after, 1) : Promise.resolve(),
        });
      }
      this.notifyChanged();
      return { ...result, page: { ...result.page, text: after.draft?.text ?? result.page.text } };
    });
  }

  private restoreText(state: TextState, direction: 1 | -1): Promise<void> {
    return this.run(async () => {
      const page = await this.engine.request({ method: 'textPage', start: state.start, count: state.count }) as TextPage;
      const restored = await this.engine.request({ method: 'textEdit', edit: { start: state.start, count: state.count, revision: page.revision, text: state.valid } }) as TextEditResult;
      if (restored.error) throw new Error(restored.error);
      let changes = restored.changes;
      for (const edit of state.cells ?? []) changes = (await this.engine.request({ method: 'edit', edit }) as { changes: number }).changes;
      const finalPage = await this.engine.request({ method: 'textPage', start: state.start, count: state.count }) as TextPage;
      // Restore original fields and preserve their prior quote and byte formatting.
      this.dirty = changes;
      this.textDraft = state.draft ? { start: state.start, count: state.count, ...state.draft } : undefined;
      this.historyCursor += direction;
      this.notifyChanged();
      this.notify({ type: 'textState', page: { ...finalPage, text: state.draft?.text ?? finalPage.text }, error: state.draft?.error });
    });
  }

  async refresh(): Promise<void> {
    if (this.query.sort || this.query.filters.length) {
      if (this.lastError) throw new Error(this.lastError);
      if (!this.metadata?.complete) await new Promise<void>((resolve, reject) => { this.scanWaiter = { resolve, reject }; });
      await this.engine.request({ method: 'query', query: this.query });
    }
    this.notifyChanged();
  }

  notifyChanged(): void {
    this.notify({ type: 'changed', changes: this.changes, canUndo: this.historyCursor > 0, canRedo: this.historyCursor < this.historyLength });
  }

  save(target = this.uri, options: SaveOptions = { edits: true, sort: false, filters: false }, history?: VersionHistory): Promise<void> {
    return this.run(async () => {
      if (this.textDraft) throw new Error(t('Fix the CSV syntax in Text before saving. Your draft is still available in Text.'));
      if (target.scheme !== 'file') throw new Error(t('Save to a local file.'));
      if (target.toString() === this.uri.toString() && await this.diskFingerprint() !== this.fingerprint) {
        throw new Error(t('The file changed on disk. Revert to reload it, or use Save As to preserve your edits.'));
      }
      await history?.capture(target.fsPath, this.metadata?.hasHeader ?? true, this.format);
      const saved = await this.engine.request({ method: 'save', target: target.fsPath, options: { ...options, encoding: options.encoding ?? this.format.encoding } });
      if (target.toString() === this.uri.toString() && options.encoding) this.format = { ...this.format, encoding: options.encoding };
      if (saved) this.acceptSnapshot(saved as Metadata);
      if (target.toString() === this.uri.toString()) {
        if (this.sourcePath !== this.uri.fsPath) {
          this.acceptSnapshot(await this.engine.request({ method: 'open', path: this.uri.fsPath, hasHeader: this.metadata?.hasHeader, format: this.format }) as Metadata);
          this.sourcePath = this.uri.fsPath;
        }
        this.restored = false;
        if (options.sort || options.filters || !options.edits) {
          this.query = { filters: [], sort: null };
          this.dirty = 0; this.textDraft = undefined;
          this.historyCursor = this.historyLength = 0;
          this.historyGeneration++;
          this.notify({ type: 'viewReset' });
        } else {
          this.dirty = 0;
          this.historyCursor = this.historyLength = 0; this.historyGeneration++;
        }
        this.fingerprint = await this.diskFingerprint();
        await this.refresh();
      }
    });
  }

  recover(snapshot: string, hasHeader: boolean, history: VersionHistory | undefined, format = this.format): Promise<void> {
    return this.run(async () => {
      if (this.changes) throw new Error(t('Save your edits before replacing this file with a saved version.'));
      if (await this.diskFingerprint() !== this.fingerprint) throw new Error(t('The file changed on disk. Reload it before recovering.'));
      const temp = join(dirname(this.uri.fsPath), `.${basename(this.uri.fsPath)}.${randomUUID()}.tmp`);
      try {
        await copyFile(snapshot, temp);
        await history?.capture(this.uri.fsPath, this.metadata?.hasHeader ?? true, this.format);
        if (await this.diskFingerprint() !== this.fingerprint) throw new Error(t('The file changed on disk. Reload it before recovering.'));
        await rename(temp, this.uri.fsPath);
      } finally { await unlink(temp).catch(() => {}); }
      this.query = { filters: [], sort: null };
      this.metadata = undefined;
      this.format = format;
      this.acceptSnapshot(await this.engine.request({ method: 'open', path: this.uri.fsPath, hasHeader, format: this.format }) as Metadata);
      this.sourcePath = this.uri.fsPath;
      this.dirty = 0; this.textDraft = undefined; this.restored = false;
      this.historyCursor = this.historyLength = 0; this.historyGeneration++;
      this.fingerprint = await this.diskFingerprint();
      this.notify({ type: 'viewReset' }); this.notifyChanged();
    });
  }

  backup(destination: vscode.Uri): Promise<string> {
    return this.run(async () => {
      await this.engine.request({ method: 'save', target: destination.fsPath, options: { edits: true, sort: false, filters: false, encoding: 'utf8' } });
      return JSON.stringify({ uri: destination.toString(), fingerprint: this.fingerprint, hasHeader: this.metadata?.hasHeader,
        format: { ...this.format, encoding: 'utf8' }, outputEncoding: this.format.encoding, textDraft: this.textDraft });
    });
  }

  revert(): Promise<void> {
    return this.run(async () => {
      this.lastError = undefined;
      const hasHeader = this.metadata?.hasHeader;
      this.metadata = undefined;
      this.acceptSnapshot(await this.engine.request({ method: 'open', path: this.uri.fsPath, hasHeader, format: this.format }) as Metadata);
      this.sourcePath = this.uri.fsPath;
      this.restored = false;
      this.dirty = 0; this.textDraft = undefined;
      this.historyCursor = this.historyLength = 0;
      this.historyGeneration++;
      this.fingerprint = await this.diskFingerprint();
      await this.refresh();
    });
  }

  private acceptSnapshot(data: Metadata): void {
    // The worker emits scan start first; responses must not replace newer progress from the same scan.
    if (!this.metadata || data.scanned >= this.metadata.scanned) this.metadata = { ...data, encoding: this.format.encoding };
    this.notify({ type: 'metadata', data: this.metadata });
  }

  private async diskFingerprint(): Promise<string> {
    try {
      const info = await stat(this.uri.fsPath);
      return `${info.size}:${info.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  dispose(): void {
    this.scanWaiter?.reject(new Error(t('The CSV document is closed.')));
    this.scanWaiter = undefined;
    this.engine.dispose();
    this.disposeEvent.fire();
    this.disposeEvent.dispose();
  }
}
