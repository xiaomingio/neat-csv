/*
File purpose: Coordinate table clipboard transfers against captured selections and clear cut cells only after a successful write.
*/
import type { CellSelection, ChangeOperation } from '../protocol';

export type TableClipboardSnapshot = {
  selection: CellSelection;
  version: string | number;
  pasteColumns: number[];
};
export type TableClipboardContext = {
  capture(): TableClipboardSnapshot | undefined;
  current(snapshot: TableClipboardSnapshot): boolean;
  copy(selection: CellSelection, includeHeaders?: boolean): Promise<string>;
  read(): Promise<string>;
  write(text: string): Promise<void>;
  change(operation: ChangeOperation): Promise<void>;
  copied(snapshot: TableClipboardSnapshot, mode: 'copy' | 'cut'): void;
  busy(label: string | null): void;
};

export class TableClipboard {
  private active = false;
  constructor(private readonly context: TableClipboardContext) {}
  get busy(): boolean { return this.active; }

  async copy(includeHeaders = false): Promise<void> {
    await this.transfer('Copying…', async () => {
      const snapshot = this.capture(), text = await this.context.copy(snapshot.selection, includeHeaders);
      this.ensureCurrent(snapshot);
      await this.context.write(text);
      this.ensureCurrent(snapshot);
      this.context.copied(snapshot, 'copy');
    });
  }

  async copyText(text: string): Promise<void> {
    await this.transfer('Copying…', () => this.context.write(text));
  }

  async cut(): Promise<void> {
    await this.transfer('Cutting…', async () => {
      const snapshot = this.capture(), text = await this.context.copy(snapshot.selection);
      this.ensureCurrent(snapshot);
      await this.context.write(text);
      this.ensureCurrent(snapshot);
      await this.context.change({ kind: 'fill', selection: snapshot.selection, value: '' });
      this.context.copied(snapshot, 'cut');
    });
  }

  async paste(text?: string): Promise<void> {
    await this.transfer('Pasting…', async () => {
      const snapshot = this.capture();
      const content = text ?? await this.context.read();
      this.ensureCurrent(snapshot);
      await this.context.change({ kind: 'paste', row: snapshot.selection.start, columns: snapshot.pasteColumns, text: content });
    });
  }

  private capture(): TableClipboardSnapshot {
    const snapshot = this.context.capture();
    if (!snapshot) throw new Error('Select cells in Table mode first.');
    if (snapshot.selection.cells !== undefined) {
      const cells = snapshot.selection.cells;
      if (!cells.length || cells.length > 100000) throw new Error('Select up to 100,000 individual cells.');
      const rows = new Map<number, Set<number>>(), columns = new Set(snapshot.selection.columns);
      for (const cell of cells) {
        if (!Number.isSafeInteger(cell.row) || !Number.isInteger(cell.col) || !columns.has(cell.col)) throw new Error('Copy and paste require a rectangular selection. Select one range.');
        if (!rows.has(cell.row)) rows.set(cell.row, new Set()); rows.get(cell.row)!.add(cell.col);
      }
      const rowCount = snapshot.selection.ranges?.reduce((sum, range) => sum + range.count, 0) ?? snapshot.selection.count;
      if (rows.size !== rowCount || [...rows.values()].some(row => row.size !== columns.size)) throw new Error('Copy and paste require a rectangular selection. Select one range.');
    }
    return {
      version: snapshot.version,
      pasteColumns: [...snapshot.pasteColumns],
      selection: { ...snapshot.selection, columns: [...snapshot.selection.columns], ranges: snapshot.selection.ranges?.map(range => ({ ...range })), ...(snapshot.selection.cells ? { cells: snapshot.selection.cells.map(cell => ({ ...cell })) } : {}) },
    };
  }

  private ensureCurrent(snapshot: TableClipboardSnapshot): void {
    if (!this.context.current(snapshot)) throw new Error('The table or selection changed during the clipboard operation. Try again.');
  }

  private async transfer(label: string, action: () => Promise<void>): Promise<void> {
    if (this.active) throw new Error('Wait for the clipboard operation to finish.');
    this.active = true;
    try { this.context.busy(label); await action(); }
    finally { this.active = false; this.context.busy(null); }
  }
}
