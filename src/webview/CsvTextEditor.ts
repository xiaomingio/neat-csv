/*
Manage progressive CSV text loading, visual alignment, bounded scrolling, and serialized edits.
*/
import { t, locale } from '../Locale';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { CsvTextRectangle } from './CsvTextRectangle';
import { TextLineEndings } from './TextLineEndings';
import { CsvTextLayout } from './CsvTextLayout';
import { csvTextDecorations } from './CsvTextDecorations';
import { csvTextFolding } from './CsvTextFolding';
import { TEXT_WINDOW_BYTES, TEXT_WINDOW_RECORDS, type TextPage, type TextEdit, type TextEditResult } from '../protocol';

type TextHost = {
  page(start: number, count: number): Promise<TextPage>;
  edit(edit: TextEdit): Promise<TextEditResult>;
  changed(): void;
  align(value: boolean): void;
  collapse(value: boolean): void;
};

export class CsvTextEditor {
  readonly element = document.createElement('section');
  private readonly editorHost = document.createElement('div');
  readonly alignControl = document.createElement('button');
  readonly collapseControl = document.createElement('button');
  private readonly error = document.createElement('div');
  private readonly decoration = new Compartment();
  private readonly folding = new Compartment();
  private editor?: EditorView;
  private data?: TextPage;
  private lineEndings?: TextLineEndings;
  private pending?: string;
  private sending?: Promise<void>;
  private loading = false;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private issue = '';
  private invalid = false;
  private aligned: boolean;

  constructor(private readonly host: TextHost, aligned: boolean, private collapsed = true) {
    this.aligned = aligned; this.element.className = 'csv-text-editor'; this.element.hidden = true;
    this.element.setAttribute('aria-label', t('CSV text view'));
    const label = this.alignControl;
    this.toggleIcon(label, 'text-align', 'M5 4v16 M13 4v16 M19 4v16 M5 7h5 M5 12h5 M5 17h5 M13 7h3 M13 12h3 M13 17h3');
    label.setAttribute('aria-label', t('Align')); label.setAttribute('aria-checked', String(aligned));
    label.onclick = () => this.setAligned(!this.aligned);
    label.dataset.tooltip = t('Click: align CSV columns visually without changing the file');
    this.toggleIcon(this.collapseControl, 'text-fold', 'M4 5h16 M4 10h8 M4 19h16 M20 10v5h-7 m3-3-3 3 3 3');
    this.collapseControl.setAttribute('aria-label', t('Fold multiline')); this.collapseControl.setAttribute('aria-checked', String(collapsed));
    this.collapseControl.dataset.tooltip = t('Click: show each CSV record on one line; turn off to edit line breaks');
    this.collapseControl.onclick = () => this.setCollapsed(!this.collapsed);
    locale.subscribe(() => {
      label.setAttribute('aria-label', t('Align')); label.dataset.tooltip = t('Click: align CSV columns visually without changing the file');
      this.collapseControl.setAttribute('aria-label', t('Fold multiline'));
      this.collapseControl.dataset.tooltip = t('Click: show each CSV record on one line; turn off to edit line breaks');
      this.element.setAttribute('aria-label', t('CSV text view')); this.editor?.contentDOM.setAttribute('aria-label', t('CSV source')); this.renderTools();
    });
    this.error.className = 'text-error'; this.error.setAttribute('role', 'alert'); this.error.hidden = true;
    this.editorHost.className = 'text-code'; this.element.append(this.editorHost, this.error);
  }

  updateTotal(total: number): void {
    if (this.data) { this.data.total = total; this.renderTools(); void this.extend(); }
  }

  get visible(): boolean { return !this.element.hidden; }

  private toggleIcon(button: HTMLButtonElement, className: string, path: string): void {
    button.type = 'button'; button.className = `${className} icon-button text-toggle`; button.hidden = true;
    button.setAttribute('role', 'checkbox');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path);
    svg.append(shape); button.append(svg);
  }

  setAligned(value: boolean): void {
    this.aligned = value; this.alignControl.setAttribute('aria-checked', String(value));
    this.host.align(value); this.configure();
  }

  setCollapsed(value: boolean): void {
    this.collapsed = value; this.collapseControl.setAttribute('aria-checked', String(value));
    this.host.collapse(value); this.configure();
  }

  async open(start = 0, focus = true): Promise<void> {
    this.element.hidden = false; this.alignControl.hidden = false; this.collapseControl.hidden = false;
    await this.load(start);
    if (focus) this.editor?.focus();
  }

  async preview(): Promise<void> {
    this.element.hidden = false; this.alignControl.hidden = false; this.collapseControl.hidden = false;
    if (!this.editor) await this.load(0);
  }

  async hide(): Promise<boolean> {
    if (!(await this.flush())) return false;
    this.element.hidden = true; this.alignControl.hidden = true; this.collapseControl.hidden = true; return true;
  }

  async refresh(): Promise<void> {
    if (this.visible && this.pending === undefined && !this.sending) await this.load(this.data?.start ?? 0, this.data?.count || 200);
  }

  async reload(): Promise<void> {
    this.loading = true; this.renderTools();
    try {
      const start = Math.min(this.data?.start ?? 0, Math.max(0, (this.data?.total ?? 1) - 1));
      this.accept(await this.host.page(start, this.data?.count || 200));
    } finally { this.loading = false; this.renderTools(); }
  }

  accept(page: TextPage, error = ''): void {
    error ||= page.draftError ?? '';
    this.data = page; this.pending = undefined; this.issue = error; this.invalid = Boolean(error);
    this.mount(page); this.renderTools();
  }

  private configure(): void {
    if (this.editor && this.data) this.editor.dispatch({ effects: [
      this.decoration.reconfigure(csvTextDecorations(this.data.delimiter, this.aligned, this.collapsed)),
      this.folding.reconfigure(this.collapsed ? csvTextFolding(this.data.delimiter) : []),
    ] });
  }

  private mount(page: TextPage): void {
    this.editor?.destroy();
    this.lineEndings = new TextLineEndings(page.text, page.newline);
    const state = EditorState.create({ doc: this.lineEndings.text, extensions: [
      EditorState.tabSize.of(4), EditorState.readOnly.of(!page.count),
      EditorState.allowMultipleSelections.of(true), crosshairCursor(),
      rectangularSelection({ eventFilter: event => !this.aligned && !this.collapsed && event.altKey && event.button === 0 }),
      EditorView.mouseSelectionStyle.of((view, event) => (this.aligned || this.collapsed) && event.altKey && event.button === 0 ? new CsvTextRectangle(view, event, page.delimiter, this.collapsed, this.aligned) : null),
      lineNumbers(), drawSelection(), highlightActiveLine(), highlightSelectionMatches(),
      keymap.of([...searchKeymap, ...defaultKeymap]),
      EditorView.contentAttributes.of({ 'aria-label': t('CSV source'), spellcheck: 'false' }),
      this.decoration.of(csvTextDecorations(page.delimiter, this.aligned, this.collapsed)),
      this.folding.of(this.collapsed ? csvTextFolding(page.delimiter) : []),
      EditorView.theme({ '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--text-selection)' } }),
      EditorView.domEventHandlers({ scroll: () => { void this.extend(); } }),
      EditorState.transactionFilter.of(transaction => {
        if (this.loading && transaction.docChanged && !transaction.annotation(Transaction.remote)) return [];
        if (transaction.docChanged && new TextEncoder().encode(transaction.newDoc.sliceString(0, transaction.newDoc.length, page.newline)).length > TEXT_WINDOW_BYTES) {
          this.issue = 'This text selection exceeds the editing memory limit.'; this.renderTools(); return [];
        }
        return transaction;
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || update.transactions.some(transaction => transaction.annotation(Transaction.remote))) return;
        this.lineEndings!.update(update.changes);
        this.pending = this.lineEndings!.serialize(update.state.doc.toString());
        this.issue = ''; this.renderTools();
        clearTimeout(this.sendTimer); this.sendTimer = setTimeout(() => void this.send(), 200);
      }),
    ] });
    this.editor = new EditorView({ state, parent: this.editorHost });
  }

  private send(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.sendPending().finally(() => { this.sending = undefined; this.renderTools(); void this.extend(); });
    return this.sending;
  }

  private async sendPending(): Promise<void> {
    while (this.pending !== undefined && this.data) {
      const text = this.pending; this.pending = undefined;
      try {
        const result = await this.host.edit({ start: this.data.start, count: this.data.count, revision: this.data.revision, text });
        this.data = result.page; this.issue = result.error ?? ''; this.invalid = Boolean(result.error); this.host.changed();
      } catch (error) {
        this.pending = text; this.invalid = true; this.issue = error instanceof Error ? error.message : String(error); break;
      }
    }
  }

  async flush(): Promise<boolean> {
    clearTimeout(this.sendTimer);
    if (this.pending !== undefined || this.sending) await this.send();
    this.renderTools(); return !this.invalid && this.pending === undefined;
  }

  private async extend(): Promise<void> {
    const view = this.editor, data = this.data;
    if (!view || !data || !this.visible || this.loading || this.sending || this.invalid) return;
    const scroll = view.scrollDOM;
    const backwards = scroll.scrollTop < 80 && data.start > 0;
    if (!backwards && (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 160 || data.start + data.count >= data.total)) return;
    this.loading = true;
    try {
      if (!(await this.flush()) || this.editor !== view || !this.visible) return;
      const current = this.data!;
      const start = backwards ? Math.max(0, current.start - 200) : current.start + current.count;
      let page = await this.host.page(start, backwards ? current.start - start : 200);
      while (backwards && page.count && page.start + page.count < current.start) page = await this.host.page(page.start + page.count, current.start - page.start - page.count);
      if (this.editor !== view || !this.visible || !page.count) return;
      if (page.revision !== current.revision) { this.issue = 'The file changed. Reopen Text to refresh it.'; return; }
      // Retain overlap around the visible records when trimming the text buffer.
      while (page.count > 1 && new TextEncoder().encode(page.text).length > TEXT_WINDOW_BYTES / 2) {
        const offsets = new CsvTextLayout(page.text, current.delimiter).records;
        const half = Math.floor(page.count / 2);
        if (backwards) page = { ...page, start: page.start + half, count: page.count - half, text: page.text.slice(offsets[half]) };
        else page = { ...page, count: half, text: page.text.slice(0, offsets[half]) };
      }
      const source = view.state.doc.toString();
      const incoming = new TextLineEndings(page.text, page.newline).text;
      const combinedEndings = new TextLineEndings(backwards ? page.text + this.lineEndings!.serialize(source) : this.lineEndings!.serialize(source) + page.text, current.newline);
      const combined = backwards ? incoming + source : source + incoming;
      const offsets = new CsvTextLayout(combined, current.delimiter).records;
      let from = 0, to = combined.length, first = backwards ? page.start : current.start;
      let count = current.count + page.count;
      while (count > TEXT_WINDOW_RECORDS || new TextEncoder().encode(combinedEndings.serialize(combined.slice(from, to), from)).length > TEXT_WINDOW_BYTES) {
        const trim = Math.max(1, Math.floor(count / 4));
        if (backwards) { count -= trim; to = offsets[count]!; }
        else { from = offsets[first - current.start + trim]!; first += trim; count -= trim; }
      }
      const removed = backwards ? 0 : from, added = backwards ? incoming.length : 0;
      const retainedEnd = backwards ? to - added : source.length;
      if (view.state.selection.ranges.some(range => !range.empty && (range.from < removed || range.to > retainedEnd)) || view.state.selection.ranges.length > 1 && view.state.selection.ranges.some(range => range.from < removed || range.to > retainedEnd)) {
        this.issue = 'The selection reached the text memory limit. Release it to continue scrolling.'; return;
      }
      const scrollTop = scroll.scrollTop;
      const lineCount = (text: string) => this.collapsed ? new CsvTextLayout(text, current.delimiter).records.length - 1 : text.split('\n').length - 1;
      const lineShift = (backwards ? lineCount(incoming) : -lineCount(source.slice(0, removed))) * view.defaultLineHeight;
      const raw = combinedEndings.serialize(combined.slice(from, to), from);
      this.lineEndings = new TextLineEndings(raw, current.newline);
      this.data = { ...current, start: first, count, total: page.total, text: raw, revision: page.revision };
      const changes = backwards ? [{ from: 0, insert: incoming }, ...(retainedEnd < source.length ? [{ from: retainedEnd, to: source.length }] : [])] : [...(removed ? [{ from: 0, to: removed }] : []), { from: source.length, insert: incoming }];
      view.dispatch({ changes, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
      if (lineShift) {
        await new Promise<void>(resolve => requestAnimationFrame(() => {
          if (this.editor === view) scroll.scrollTop = Math.max(0, scrollTop + lineShift);
          requestAnimationFrame(() => resolve());
        }));
      }
      this.issue = '';
    } catch (error) { this.issue = error instanceof Error ? error.message : String(error); }
    finally { this.loading = false; this.renderTools(); }
  }

  private async load(start: number, count = 200): Promise<void> {
    this.loading = true; this.renderTools();
    try { this.accept(await this.host.page(start, count)); }
    catch (error) { this.issue = error instanceof Error ? error.message : String(error); }
    finally { this.loading = false; this.renderTools(); }
  }

  private renderTools(): void {
    this.error.hidden = !this.issue; this.error.textContent = t(this.issue);
  }
}
