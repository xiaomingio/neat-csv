/*
Provide full-file search, bulk edits, row and column commands, and data checks.
*/
import { t } from '../Locale';
import { DataDialogs } from './DataDialogs';
import { CheckPanel } from './CheckPanel';
import type { CellSelection, ChangeOperation, SearchOptions, SearchResult, CheckResult, CheckOptions, Metadata, FileFormat } from '../protocol';

type Context = {
  metadata: () => Metadata | undefined;
  prepare: () => Promise<void>;
  selectIssues: (issues: CheckResult['issues']) => Promise<void>;
  selection: () => CellSelection | undefined;
  columns: () => number[];
  hidden: () => number[];
  visibility: (hidden: number[]) => void;
  search: (options: SearchOptions) => Promise<SearchResult>;
  check: (kind: 'duplicates' | 'missing' | 'ragged', columns?: number[], after?: CheckOptions['after']) => Promise<CheckResult>;
  change: (operation: ChangeOperation) => Promise<void>;
  configure: (format: FileFormat) => Promise<void>;
  locate: (row: number, col?: number) => Promise<void>;
  selectedRows: () => Promise<number[]>;
  paste: () => Promise<void>;
};

export class DataTools {
  private readonly dialogs: DataDialogs;
  private readonly checks: CheckPanel;
  constructor(root: HTMLElement, private readonly context: Context) {
    this.dialogs = new DataDialogs(root);
    this.checks = new CheckPanel(root, context);
  }
  invalidateChecks(): void { this.checks.markStale(); }
  get open(): boolean { return this.dialogs.open; }

  private columnSelect(all = true): HTMLSelectElement {
    const columns: [string, string][] = this.context.metadata()?.headers.map((name, col) => [String(col), name || t('Column {number}', { number: col + 1 })]) ?? [];
    return this.dialogs.select('Column', all ? [['all', t('All columns')], ...columns] : columns);
  }

  search(selectionOnly = false): void {
    const d = this.dialogs, find = d.input('Find'), replacement = d.input('Replace with');
    const columns = this.columnSelect(), sensitive = d.check('Match case'), regex = d.check('Regular expression');
    const results = document.createElement('div'); results.className = 'data-results';
    const message = document.createElement('p'); message.className = 'data-message'; message.setAttribute('role', 'status');
    const scope = d.select('Search scope', [['all', t('Entire file')], ['selection', t('Current selection')]], selectionOnly && this.context.selection() ? 'selection' : 'all');
    const selectionOption = scope.querySelector<HTMLOptionElement>('option[value="selection"]')!;
    selectionOption.disabled = !this.context.selection();
    const options = (): SearchOptions => ({ text: find.value, columns: columns.value === 'all' ? undefined : [Number(columns.value)], caseSensitive: sensitive.querySelector('input')!.checked, regex: regex.querySelector('input')!.checked, limit: 200, ...(scope.value === 'selection' ? { selection: this.requireSelection() } : {}) });
    let after: SearchOptions['after'], revision = 0;
    const next = document.createElement('button'); next.textContent = t('Next matches'); next.hidden = true;
    const search = async (continueAfter = false) => {
      if (!find.value) throw new Error(t('Enter text to find.'));
      if (!continueAfter) after = undefined;
      const current = ++revision;
      const result = await this.context.search({ ...options(), after });
      if (current !== revision || !d.open || !find.isConnected) return;
      results.replaceChildren();
      after = result.matches.at(-1) ? { row: result.matches.at(-1)!.row, col: result.matches.at(-1)!.col } : undefined; next.hidden = !result.truncated;
      message.textContent = `${t('{count} matching cells', { count: result.total.toLocaleString() })}${result.truncated ? ` · ${t('More matches available')}` : ''}`;
      for (const match of result.matches) {
        const button = document.createElement('button'); button.textContent = `${this.context.metadata()?.headers[match.col] || t('Column {number}', { number: match.col + 1 })} #${match.row + 1} · ${match.value.slice(0, 180)}`;
        button.onclick = () => { void this.context.locate(match.row, match.col).then(() => d.dialog.close()).catch(error => { message.textContent = t(error instanceof Error ? error.message : String(error)); }); }; results.append(button);
      }
    };
    for (const input of [find, columns, sensitive, regex, scope]) input.addEventListener('input', () => { revision++; after = undefined; next.hidden = true; results.replaceChildren(); message.textContent = ''; });
    next.onclick = () => { next.disabled = true; void search(true).catch(error => { message.textContent = t(error instanceof Error ? error.message : String(error)); }).finally(() => { next.disabled = false; }); };
    find.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); d.dialog.querySelector<HTMLButtonElement>('footer button:nth-child(2)')?.click(); } });
    d.show('Find and replace', d.body(d.field('Find', find), d.field('Replace with', replacement), d.field('Search scope', scope), d.field('Column', columns), sensitive, regex, message, results, next), [
      { label: 'Find all', run: () => search() },
      { label: 'Replace matches', run: async () => {
        if (!find.value) throw new Error(t('Enter text to find.'));
        const { selection, ...searchOptions } = options();
        await this.context.change({ kind: 'replace', search: searchOptions, replacement: replacement.value, ...(selection ? { selection } : {}) });
        selectionOption.disabled = !this.context.selection();
        if (selectionOption.disabled) scope.value = 'all';
        after = undefined; next.hidden = true; results.replaceChildren(); message.textContent = t('Replacement applied. Use Undo to revert.');
      } },
    ]);
  }

  private requireSelection(): CellSelection {
    const selection = this.context.selection(); if (!selection) throw new Error(t('Select cells in Table mode first.')); return selection;
  }

  fill(clear = false): void {
    const d = this.dialogs, selection = this.requireSelection();
    const value = d.input('Value');
    const message = document.createElement('p'); message.className = 'data-message'; message.textContent = selection.cells ? t('{count} selected cells. This can be undone.', { count: selection.cells.length }) : t('{rows} rows × {columns} columns. This can be undone.', { rows: selection.ranges?.reduce((total, range) => total + range.count, 0) ?? selection.count, columns: selection.columns.length });
    d.show(clear ? 'Clear selected cells' : 'Fill selected cells', d.body(...(!clear ? [d.field('Value', value)] : []), message), [{ label: clear ? 'Clear cells' : 'Fill cells', close: true, run: () => this.context.change({ kind: 'fill', selection, value: clear ? '' : value.value }) }]);
  }

  paste(): Promise<void> { return this.context.paste(); }

  insertRows(before?: number): void {
    const d = this.dialogs, metadata = this.context.metadata();
    const at = d.input('Before original row', String((before ?? metadata?.rows ?? 0) + 1), 'number'); at.min = '1'; at.max = String((metadata?.rows ?? 0) + 1);
    const count = d.input('Number of rows', '1', 'number'); count.min = '1'; count.max = '100000';
    d.show('Insert rows', d.body(d.field('Before row #', at), d.field('Rows', count)), [{ label: 'Insert', close: true, run: () => {
      const index = Number(at.value), amount = Number(count.value);
      if (!Number.isInteger(index) || index < 1 || index > (metadata?.rows ?? 0) + 1 || !Number.isInteger(amount) || amount < 1 || amount > 100000) throw new Error(t('Enter a valid row and 1–100,000 rows to insert.'));
      return this.context.change({ kind: 'insertRows', at: index - 1, count: amount });
    } }]);
  }

  async deleteRows(): Promise<void> {
    this.requireSelection(); const rows = await this.context.selectedRows();
    const message = document.createElement('p'); message.className = 'data-message'; message.textContent = t('Delete {count} selected rows, including their hidden columns? This can be undone.', { count: rows.length.toLocaleString() });
    this.dialogs.show('Delete selected rows', this.dialogs.body(message), [{ label: 'Delete rows', close: true, run: () => this.context.change({ kind: 'deleteRows', rows }) }]);
  }

  insertColumn(at?: number): void {
    const d = this.dialogs, name = d.input('Column name'), before = this.columnSelect(false);
    const last = document.createElement('option'); last.value = String(this.context.metadata()?.headers.length ?? 0); last.textContent = t('After last column'); before.append(last); before.value = at === undefined ? last.value : String(at);
    d.show('Insert column', d.body(d.field('Name', name), d.field('Before column', before)), [{ label: 'Insert', close: true, run: () => this.context.change({ kind: 'insertColumn', at: Number(before.value), name: name.value }) }]);
  }

  deleteColumns(columns = this.requireSelection().columns): void {
    const message = document.createElement('p'); message.className = 'data-message'; message.textContent = t('Delete {count} selected columns from every row? This can be undone.', { count: columns.length });
    this.dialogs.show('Delete selected columns', this.dialogs.body(message), [{ label: 'Delete columns', close: true, run: () => this.context.change({ kind: 'deleteColumns', columns }) }]);
  }

  jump(): void {
    const input = this.dialogs.input('Original row number', '1', 'number'); input.min = '1'; input.max = String(this.context.metadata()?.rows ?? 0);
    this.dialogs.show('Go to original row', this.dialogs.body(this.dialogs.field('Row #', input)), [{ label: 'Go', close: true, run: async () => {
      const row = Number(input.value); if (!Number.isInteger(row) || row < 1) throw new Error(t('Enter a valid row number.')); await this.context.locate(row - 1);
    } }]);
  }

  columns(): void {
    const d = this.dialogs, search = d.input('Search columns'), list = document.createElement('div'); list.className = 'data-results';
    const hidden = new Set(this.context.hidden());
    const draw = () => {
      list.replaceChildren();
      this.context.metadata()?.headers.forEach((name, col) => {
        if (!name.toLowerCase().includes(search.value.toLowerCase())) return;
        const label = d.check(`${col + 1} · ${name || t('Column {number}', { number: col + 1 })}`, !hidden.has(col));
        label.querySelector('input')!.onchange = event => { if ((event.target as HTMLInputElement).checked) hidden.delete(col); else hidden.add(col); }; list.append(label);
      });
    }; search.oninput = draw; draw();
    d.show('Show and hide columns', d.body(search, list), [
      { label: 'Show all', run: () => { hidden.clear(); draw(); } },
      { label: 'Apply', close: true, run: () => { if (hidden.size >= (this.context.metadata()?.headers.length ?? 0)) throw new Error(t('Keep at least one column visible.')); this.context.visibility([...hidden]); } },
    ]);
  }

  format(): void {
    const d = this.dialogs, metadata = this.context.metadata();
    const encoding = d.select('Encoding', [['utf-8', 'UTF-8'], ['gb18030', 'GB18030 / GBK'], ['windows-1252', 'Windows-1252'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['shift_jis', 'Shift JIS']], ({ utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', cp1252: 'windows-1252', gbk: 'gb18030', gb2312: 'gb18030', shiftjis: 'shift_jis' }[metadata?.encoding?.toLowerCase() ?? ''] ?? metadata?.encoding ?? 'utf-8'));
    const delimiter = d.select('Delimiter', [['auto', t('Auto detect')], [',', t('Comma (,)')], [';', t('Semicolon (;)')], ['\t', t('Tab')], ['|', t('Pipe (|)')]], metadata?.delimiter ?? 'auto');
    const message = document.createElement('p'); message.className = 'data-message'; message.textContent = t('Save changes before reopening with a different file format.');
    d.show('File format', d.body(d.field('Encoding', encoding), d.field('Delimiter', delimiter), message), [{ label: 'Reopen', close: true, run: () => this.context.configure({ encoding: encoding.value, ...(delimiter.value === 'auto' ? {} : { delimiter: delimiter.value }) }) }]);
  }

  check(): void { this.checks.show(); }
}
