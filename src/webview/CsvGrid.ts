/*
File purpose: Manage the virtual CSV grid, column layout, editing, and host messages.
*/
import { locale, t } from '../Locale';
import { LanguageMenu } from './LanguageMenu';
import { QuickGuide, type GuideStep } from './QuickGuide';
import { DataTools } from './DataTools';
import { Tooltips } from './Tooltips';
import { ToolbarMenu } from './ToolbarMenu';
import { CsvTextEditor } from './CsvTextEditor';
import { FileDialogs } from './FileDialogs';
import { PromptDialog } from './PromptDialog';
import { RowLayout } from './RowLayout';
import { CellSelection } from './CellSelection';
import { RowDrag } from './RowDrag';
import { InlineCellEditor } from './InlineCellEditor';
import { TableClipboard, type TableClipboardSnapshot } from './TableClipboard';
import type { ClientMessage, HostMessage, Filter, Metadata, Page, Query, SelectionStats, VersionList, RowPinsResult, TextPage, TextEditResult, CellSelection as SelectionRequest, ChangeOperation, ChangeResult, SearchResult, CheckResult, CheckOptions, DistinctResult, LocateResult } from '../protocol';

type ViewState = { hidden?: number[]; alignText?: boolean; collapseText?: boolean; sortTypes?: Record<number, boolean | 'auto'>; theme?: 'light' | 'dark'; order?: number[]; frozen?: number[]; widths?: Record<number, number> };
type VsCode = { postMessage(message: ClientMessage): void; getState(): ViewState | undefined; setState(state: ViewState): void };
declare function acquireVsCodeApi(): VsCode;
type Request = ClientMessage extends infer T ? T extends ClientMessage ? Omit<T, 'id'> : never : never;
type Cell = { row: number; col: number; index: number; value: string };
type Icon = 'undo' | 'redo' | 'sun' | 'moon' | 'filter' | 'move' | 'sort' | 'ascending' | 'descending' | 'text' | 'table' | 'help';
const DEFAULT_WIDTH = 180;
const MIN_WIDTH = 132;
const MIN_NUMBER_WIDTH = 64;
const PAGE_SIZE = 100;
const MAX_HEIGHT = 8_000_000;

export class CsvGrid {
  private readonly vscode = acquireVsCodeApi();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly pages = new Map<number, Page>();
  private readonly pageBytes = new Map<number, number>();
  private readonly pageCellBytes = new Map<number, number[][]>();
  private cachedBytes = 0;
  private readonly loading = new Set<number>();
  private readonly failed = new Set<number>();
  private readonly toolbar = document.createElement('header');
  private readonly heading = document.createElement('div');
  private readonly viewport = document.createElement('main');
  private readonly canvas = document.createElement('div');
  private readonly status = document.createElement('footer');
  private readonly textEditor: CsvTextEditor;
  private readonly guide: QuickGuide;
  private readonly textButton: HTMLButtonElement;
  private readonly fileDialogs: FileDialogs;
  private readonly promptDialog: PromptDialog;
  private readonly inlineEditor: InlineCellEditor;
  private readonly themeButton: HTMLButtonElement;
  private readonly headerButton: HTMLButtonElement;
  private readonly fileMenu: ToolbarMenu;
  private readonly viewMenu: ToolbarMenu;
  private readonly dataTools: DataTools;
  private readonly editMenu: ToolbarMenu;
  private readonly dataMenu: ToolbarMenu;
  private readonly rowLayout = new RowLayout();
  private readonly selection = new CellSelection();
  private readonly clipboard: TableClipboard;
  private readonly rowDrag: RowDrag;
  private clipboardStatus = '';
  private clipboardMarker?: { selection: SelectionRequest; mode: 'copy' | 'cut' };
  private pendingLink?: ReturnType<typeof setTimeout>;
  private selectionOrigin?: { x: number; y: number };
  private selecting = false;
  private axisSelecting?: 'rows' | 'columns';
  private selectionMoved = false;
  private stats?: SelectionStats;
  private statsError = '';
  private statsVersion = 0;
  private statsKey = '';
  private statsLoading = false;
  private statsInFlight = false;
  private statsTimer?: ReturnType<typeof setTimeout>;
  private autoStatsKey = '';
  private pointer?: { x: number; y: number };
  private autoScroll?: number;
  private readonly saveButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly undoMenuItem: HTMLButtonElement;
  private readonly redoMenuItem: HTMLButtonElement;
  private readonly collapseMenuItem: HTMLButtonElement;
  private readonly alignMenuItem: HTMLButtonElement;
  private readonly modeMenuItem: HTMLButtonElement;
  private readonly themeMenuItem: HTMLButtonElement;
  private readonly guideMenuItem: HTMLButtonElement;
  private readonly calculateMenuItem: HTMLButtonElement;
  private state: ViewState;
  private sequence = 0;
  private generation = 0;
  private metadata?: Metadata;
  private total = 0;
  private changes = 0;
  private refreshing = false;
  private order: number[] = [];
  private frozen = new Set<number>();
  private numberWidth = MIN_NUMBER_WIDTH;
  private rowPins: number[] = [];
  private visibleRowPins: number[] = [];
  private pinnedScrollTop = 0;
  private query: Query = { filters: [], sort: null };
  private selected?: Cell;
  private menu?: HTMLElement;
  private error = '';
  private operation = '';
  private scheduled = false;
  private dragged?: number;
  private dragImage?: HTMLElement;
  private dropAfter = false;
  private resizing = false;
  private canUndo = false;
  private canRedo = false;
  private guideReturnText = false;
  private readonly tooltips: Tooltips;

  constructor(private readonly root: HTMLElement) {
    this.state = this.vscode.getState() ?? {};
    this.root.className = 'csv-editor';
    this.toolbar.className = 'toolbar';
    this.toolbar.setAttribute('aria-label', t('CSV tools'));
    this.undoButton = this.iconButton('undo', 'Undo (Ctrl/Cmd+Z)', () => void this.history('undo'));
    this.redoButton = this.iconButton('redo', 'Redo (Ctrl/Cmd+Shift+Z)', () => void this.history('redo'));
    this.saveButton = this.button('Save', 'Save (Ctrl/Cmd+S)', () => void this.save(), 'S');
    this.headerButton = this.button('First row as headers', 'Use first row as column headers', () => void this.toggleHeader());
    this.headerButton.classList.add('table-tool');
    const resetView = this.button('Reset view', 'Clear filters, sorting, and column layout', () => {
      const reset = async () => {
        if (!(await this.setQuery({ filters: [], sort: null }))) return;
        if (this.rowPins.length) {
          const result = await this.request({ type: 'pinRows', rows: [] }) as RowPinsResult;
          this.rowPins = result.rows; this.visibleRowPins = result.visibleRows;
          this.rowLayout.clear(); this.invalidate();
        }
        this.order = this.metadata?.headers.map((_, i) => i) ?? [];
        this.frozen.clear(); this.state.hidden = [];
        this.state.sortTypes = {};
        this.persist();
        this.render();
      };
      void reset();
    });
    resetView.classList.add('table-tool');
    this.fileMenu = new ToolbarMenu(this.root, 'File', [
      this.saveButton,
      this.button('Save As…', 'Save content changes to another CSV file', () => void this.save('saveAs'), 'Shift+S'),
      this.button('Export current view…', 'Export filtered rows and visible columns to another CSV file', () => void this.exportView()),
      this.button('Recover…', 'Recover a saved version', () => void this.recover())]);
    const invoke = (action: () => void | Promise<void>) => () => { void this.performTool(action); };
    this.collapseMenuItem = this.button('Fold multiline', 'Click: show each CSV record on one line; turn off to edit line breaks', () => this.textEditor.setCollapsed(!(this.state.collapseText ?? true)));
    this.alignMenuItem = this.button('Align', 'Click: align CSV columns visually without changing the file', () => this.textEditor.setAligned(!(this.state.alignText ?? true)));
    this.modeMenuItem = this.button('Switch to Text mode', 'Switch to Text mode', () => void this.toggleText());
    this.themeMenuItem = this.button('Switch color theme', 'Switch color theme', () => this.toggleTheme());
    this.guideMenuItem = this.button('Quick guide', 'Click: start the guided tour', () => this.showGuide());
    this.viewMenu = new ToolbarMenu(this.root, 'View', [this.modeMenuItem, this.alignMenuItem, this.collapseMenuItem, this.headerButton,
      this.button('Show / hide columns…', 'Click: search, hide, or show columns', invoke(() => this.dataTools.columns())),
      this.button('Go to row…', 'Click: jump to an original row number', invoke(() => this.dataTools.jump())), resetView,
      this.themeMenuItem, this.guideMenuItem]);
    this.undoMenuItem = this.button('Undo', 'Undo', () => void this.history('undo'), 'Z');
    this.redoMenuItem = this.button('Redo', 'Redo', () => void this.history('redo'), 'Shift+Z');
    this.editMenu = new ToolbarMenu(this.root, 'Edit', [
      this.undoMenuItem, this.redoMenuItem,
      this.button('Find and replace…', 'Search or replace throughout the entire file (Ctrl/Cmd+F)', invoke(() => this.dataTools.search()), 'F'),
      this.button('Copy cells', 'Copy selected cells (Ctrl/Cmd+C)', invoke(() => this.clipboardAction('copy')), 'C'),
      this.button('Copy with headers', 'Copy selected cells with column headers', invoke(() => this.clipboardAction('copyWithHeaders'))),
      this.button('Cut cells', 'Cut selected cells (Ctrl/Cmd+X)', invoke(() => this.clipboardAction('cut')), 'X'),
      this.button('Paste cells', 'Paste a rectangle from Excel into the current cell (Ctrl/Cmd+V)', invoke(() => this.dataTools.paste()), 'V'),
    ]);
    this.calculateMenuItem = this.button('Calculate selection', 'Calculate selection', () => void this.calculateSelection());
    this.dataMenu = new ToolbarMenu(this.root, 'Data', [
      this.calculateMenuItem,
      this.button('Check data…', 'Find duplicate values, empty cells, or inconsistent column counts', invoke(() => this.dataTools.check())),
      this.button('File format…', 'Reopen with a different encoding or delimiter', invoke(() => this.dataTools.format())),
    ]);
    const languageMenu = new LanguageMenu(this.root, language => { void this.run({ type: 'language', language }); }, () => { void this.run({ type: 'backupSettings' }); });
    this.toolbar.append(this.fileMenu.button, this.viewMenu.button, this.editMenu.button, this.dataMenu.button, languageMenu.button, this.undoButton, this.redoButton);
    const spacer = document.createElement('span');
    spacer.className = 'toolbar-hint'; spacer.setAttribute('aria-live', 'off');
    this.textButton = this.iconButton('text', 'Switch to Text mode', () => void this.toggleText());
    this.toolbar.append(spacer, this.textButton);
    this.themeButton = this.iconButton('sun', 'Switch color theme', () => this.toggleTheme());
    const helpButton = this.iconButton('help', 'Help: Quick guide', () => this.showGuide());
    helpButton.dataset.tooltip = t('Click: start the guided tour');
    helpButton.dataset.l10nTooltip = 'Click: start the guided tour';
    this.toolbar.append(helpButton, this.themeButton);
    this.heading.className = 'column-headings';
    this.heading.setAttribute('role', 'row');
    this.viewport.className = 'viewport';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', 'grid');
    this.viewport.setAttribute('aria-label', t('CSV data'));
    this.viewport.setAttribute('aria-multiselectable', 'true');
    this.viewport.append(this.canvas);
    this.canvas.className = 'grid-canvas';
    this.status.className = 'status';
    this.status.setAttribute('role', 'status');
    this.root.append(this.toolbar, this.heading, this.viewport, this.status);
    this.inlineEditor = new InlineCellEditor(this.root, restoreFocus => { if (restoreFocus) this.viewport.focus({ preventScroll: true }); });
    this.textEditor = new CsvTextEditor({
      page: (start, count) => this.request({ type: 'textPage', start, count }) as Promise<TextPage>,
      edit: edit => this.request({ type: 'textEdit', edit }) as Promise<TextEditResult>,
      changed: () => { this.dataTools?.invalidateChecks(); this.invalidate(); this.renderStatus(); },
      align: value => { this.state.alignText = value; this.persist(); this.renderStatus(); },
      collapse: value => { this.state.collapseText = value; this.persist(); this.renderStatus(); },
    }, this.state.alignText ?? true, this.state.collapseText ?? true);
    this.root.insertBefore(this.textEditor.element, this.status);
    this.toolbar.insertBefore(this.textEditor.alignControl, this.textButton);
    this.toolbar.insertBefore(this.textEditor.collapseControl, this.textButton);
    this.fileDialogs = new FileDialogs(this.root);
    this.clipboard = new TableClipboard({
      capture: () => this.captureClipboard(),
      current: snapshot => snapshot.version === this.captureClipboard()?.version,
      copy: (selection, includeHeaders) => this.request({ type: 'copy', ...selection, includeHeaders }) as Promise<string>,
      read: () => this.request({ type: 'clipboardRead' }) as Promise<string>,
      write: async text => { await this.request({ type: 'clipboardWrite', text }); },
      change: operation => this.applyChange(operation),
      copied: (snapshot, mode) => {
        this.clipboardMarker = mode === 'cut' && (this.query.sort || this.query.filters.length) ? undefined : { selection: snapshot.selection, mode };
        this.paintSelection();
      },
      busy: label => { this.clipboardStatus = label ?? ''; this.renderStatus(); },
    });
    this.rowDrag = new RowDrag({
      root: this.root, viewport: this.viewport,
      allowed: () => !this.query.sort && !this.query.filters.length && !this.operation && !this.clipboard.busy && !this.inlineEditor.open,
      total: () => this.metadata?.rows ?? 0,
      rowAtPointer: (_x, y) => {
        const rect = this.viewport.getBoundingClientRect();
        const element = document.elementFromPoint(rect.left + this.numberWidth / 2, y)?.closest<HTMLElement>('.grid-row');
        const row = element?.querySelector<HTMLElement>('[data-row]'), number = element?.querySelector<HTMLElement>('.row-number');
        return element && row && number ? { row: Number(row.dataset.row), index: Number(number.dataset.index), element } : undefined;
      },
      scroll: delta => { this.scrollToLogical(this.logicalScrollTop + delta); this.schedule(); },
      move: (row, before) => this.applyChange({ kind: 'moveRow', row, before }),
      error: message => this.showError(new Error(message)),
    });
    this.dataTools = new DataTools(this.root, {
      metadata: () => this.metadata,
      prepare: () => this.flushText(),
      selectIssues: issues => this.selectOriginalIssues(issues),
      selection: () => this.selectionRequest(),
      columns: () => this.visualColumns,
      hidden: () => this.state.hidden ?? [],
      visibility: hidden => { this.state.hidden = hidden; this.clearSelection(); this.persist(); this.render(); },
      search: async options => { await this.flushText(); return this.request({ type: 'search', options }) as Promise<SearchResult>; },
      check: async (kind, columns, after) => { await this.flushText(); return this.request({ type: 'check', options: { kind, columns, after, limit: 200 } }) as Promise<CheckResult>; },
      change: operation => this.applyChange(operation),
      configure: async format => { await this.flushText(); const data = await this.request({ type: 'configure', format }) as Metadata; this.resetStructure(); this.receiveMetadata(data); await this.reloadText(); },
      locate: (row, col) => this.locateRow(row, col),
      selectedRows: () => this.selectedOriginalRows(),
      paste: () => this.pasteClipboard(),
    });
    this.guide = new QuickGuide(this.root, () => { void this.run({ type: 'guideSeen' }); }, () => this.guideSteps(), () => {
      this.setTextMode(this.guideReturnText); this.renderStatus();
    });
    this.root.addEventListener('pointerdown', event => {
      clearTimeout(this.pendingLink); this.pendingLink = undefined;
      if (this.clipboard.busy) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true });
    this.root.addEventListener('keydown', event => {
      if (this.clipboard.busy) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true });
    this.viewport.addEventListener('contextmenu', event => {
      const cell = (event.target as Element).closest<HTMLElement>('[role="gridcell"][data-row]');
      if (!cell) return;
      event.preventDefault(); event.stopPropagation();
      if (!this.clipboard.busy) this.openCellMenu(cell, event.clientX, event.clientY);
    });
    this.promptDialog = new PromptDialog(this.root);
    this.tooltips = new Tooltips(this.root);
    this.applyTheme();
    new MutationObserver(() => { if (!this.state.theme) this.applyTheme(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.viewport.addEventListener('scroll', () => { this.closeMenu(); this.schedule(); }, { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.viewport);
    this.viewport.addEventListener('keydown', event => this.keydown(event));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.closeMenu();
      if (!(event.ctrlKey || event.metaKey) || this.promptDialog.open || this.fileDialogs.open || this.guide.open || this.dataTools.open) return;
      if (event.key.toLowerCase() === 'a' && !this.textEditor.visible && !this.inlineEditor.open
        && !(event.target instanceof Element && event.target.closest('input, textarea, [contenteditable=true]'))) {
        event.preventDefault(); event.stopPropagation();
        if (!this.clipboard.busy) this.selectAllCells();
        return;
      }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); void this.performTool(() => this.dataTools.search()); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void this.save(event.shiftKey ? 'saveAs' : 'save'); }
      if (event.key.toLowerCase() === 'z' && this.inlineEditor.open) return;
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); void this.history(event.shiftKey ? 'redo' : 'undo'); }
    }, { capture: true });
    document.addEventListener('paste', event => {
      if (this.clipboard.busy || this.textEditor.visible || this.inlineEditor.open || this.fileDialogs.open || this.dataTools.open || this.guide.open || (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable=true]'))) return;
      const text = event.clipboardData?.getData('text/plain');
      if (text !== undefined && this.selectionRequest()) { event.preventDefault(); void this.clipboardAction('paste', text); }
    });
    document.addEventListener('pointerdown', event => {
      if (!this.guide.open && this.menu && !this.menu.contains(event.target as Node) && !(event.target as Element).closest('.column-filter-button, .column-sort-button')) this.closeMenu();
    });
    document.addEventListener('pointermove', event => this.moveSelection(event));
    document.addEventListener('pointerup', () => {
      const wasSelecting = this.selecting;
      this.selecting = false; this.axisSelecting = undefined;
      if (wasSelecting) this.updateSelectionStats();
      if (this.autoScroll !== undefined) cancelAnimationFrame(this.autoScroll);
      this.autoScroll = undefined;
    });
    window.addEventListener('message', event => this.message(event.data as HostMessage));
    locale.subscribe(() => this.updateLanguage());
    void this.request({ type: 'ready' }).then(value => { if (value) this.receiveMetadata(value as Metadata); }).catch(error => this.showError(error));
    this.renderStatus();
  }

  private async performTool(action: () => void | Promise<void>): Promise<void> {
    if (this.operation || this.fileDialogs.open || this.guide.open) return;
    if (!(await this.inlineEditor.commit(false))) return;
    this.closeMenu();
    try { await action(); } catch (error) { this.showError(error); }
  }

  private async flushText(): Promise<void> {
    if (!(await this.inlineEditor.commit(false))) throw new Error('Finish editing the current cell first.');
    if (this.textEditor.visible && !(await this.textEditor.flush())) throw new Error('Fix the Text error before continuing.');
  }

  private async reloadText(): Promise<void> {
    if (!this.textEditor.visible) return;
    try { await this.textEditor.reload(); }
    catch (error) { await this.textEditor.hide(); this.setTextMode(false); this.render(); throw error; }
  }

  private selectionRequest(): SelectionRequest | undefined {
    if (this.textEditor.visible) return;
    const selection = this.selection.snapshot(this.total, this.visualColumns.length);
    if (!selection?.ranges.length || !selection.columns.length) return;
    const start = selection.ranges[0]!.start, last = selection.ranges.at(-1)!;
    return { start, count: last.start + last.count - start, columns: selection.columns.map(index => this.visualColumns[index]!), ranges: selection.ranges, ...(selection.cells ? { cells: selection.cells.map(cell => ({ row: cell.row, col: this.visualColumns[cell.col]! })) } : {}) };
  }

  private resetStructure(): void {
    this.closeMenu();
    this.dataTools?.invalidateChecks();
    this.order = []; this.frozen.clear(); this.state.order = []; this.state.frozen = []; this.state.hidden = []; this.state.widths = {}; this.state.sortTypes = {};
    this.rowPins = []; this.visibleRowPins = []; this.pinnedScrollTop = 0;
    this.query = { filters: [], sort: null }; this.rowLayout.clear(); this.clearSelection(); this.invalidate(); this.persist();
  }

  private async applyChange(operation: ChangeOperation): Promise<void> {
    await this.flushText();
    if (this.operation) throw new Error('Wait for the current operation to finish.');
    const marker = operation.kind === 'paste' && this.clipboardMarker?.mode === 'copy' && !this.query.sort && !this.query.filters.length && !this.pasteTouchesSource(operation, this.clipboardMarker.selection) ? this.clipboardMarker : undefined;
    this.operation = 'Applying changes…'; this.renderStatus();
    try {
      const result = await this.request({ type: 'change', operation }) as ChangeResult;
      if (['insertRows', 'deleteRows', 'insertColumn', 'deleteColumns', 'moveRow', 'moveColumn'].includes(operation.kind)) this.resetStructure();
      this.receiveMetadata(result.metadata);
      const query = await this.request({ type: 'query', query: this.query }) as { total: number };
      this.total = query.total; this.invalidate(); this.error = ''; await this.reloadText();
      if (marker) this.clipboardMarker = marker;
      this.render();
    } finally { this.operation = ''; this.renderStatus(); }
  }

  private pasteTouchesSource(operation: Extract<ChangeOperation, { kind: 'paste' }>, selection: SelectionRequest): boolean {
    let rows = 1, columns = 1, currentColumns = 1, quoted = false;
    for (let index = 0; index < operation.text.length; index++) {
      const character = operation.text[index];
      if (character === '"') { if (quoted && operation.text[index + 1] === '"') index++; else quoted = !quoted; }
      else if (!quoted && character === '\t') { currentColumns++; columns = Math.max(columns, currentColumns); }
      else if (!quoted && (character === '\n' || character === '\r')) { if (character === '\r' && operation.text[index + 1] === '\n') index++; rows++; currentColumns = 1; }
    }
    const ranges = selection.ranges ?? [{ start: selection.start, count: selection.count }];
    return ranges.some(range => range.start < operation.row + rows && range.start + range.count > operation.row)
      && operation.columns.slice(0, columns).some(column => selection.columns.includes(column));
  }

  private async pasteClipboard(text?: string): Promise<void> {
    await this.clipboard.paste(text);
  }

  private captureClipboard(): TableClipboardSnapshot | undefined {
    const selection = this.selectionRequest(); if (!selection) return;
    const firstCol = this.visualColumns.indexOf(selection.columns[0]!);
    return { selection, pasteColumns: this.visualColumns.slice(firstCol), version: JSON.stringify([this.generation, selection, this.visualColumns]) };
  }

  private async clipboardAction(action: 'copy' | 'copyWithHeaders' | 'cut' | 'paste', text?: string): Promise<void> {
    if (!(await this.inlineEditor.commit(false))) return;
    if (this.operation) { this.showError(new Error('Wait for the current operation to finish.')); return; }
    try {
      if (action === 'paste') await this.clipboard.paste(text);
      else if (action === 'copyWithHeaders') await this.clipboard.copy(true);
      else await this.clipboard[action]();
      this.error = ''; this.renderStatus();
    } catch (error) { this.showError(error); }
  }

  private openCellMenu(cell: HTMLElement, x: number, y: number): void {
    const row = Number(cell.dataset.index), col = Number(cell.dataset.col);
    if (!this.selection.contains(row, this.visualColumns.indexOf(col))) {
      this.selection.start(row, this.visualColumns.indexOf(col));
      const page = this.pageAt(row), record = page?.rows[row - page.start];
      if (record) this.selected = { row: record.id, col, index: row, value: record.values[col] ?? '' };
      this.paintSelection();
    }
    this.closeMenu();
    const menu = document.createElement('div'); menu.className = 'cell-context-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('Cell actions'));
    const add = (label: string, shortcut: string, action: () => Promise<void>, disabled = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem');
      const name = document.createElement('span'); name.textContent = t(label);
      const keys = document.createElement('span'); keys.textContent = shortcut;
      button.dataset.tooltip = `${t('Click: {action}', { action: t(label) })}${shortcut ? ` (${shortcut})` : ''}`;
      button.append(name, keys); button.disabled = disabled || Boolean(this.operation || this.clipboardStatus);
      button.onclick = () => { this.closeMenu(); this.viewport.focus({ preventScroll: true }); void action().catch(error => this.showError(error)); };
      menu.append(button);
    };
    const modifier = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
    add('Copy', `${modifier}C`, () => this.clipboardAction('copy'));
    add('Copy with headers', '', () => this.clipboardAction('copyWithHeaders'));
    add('Cut', `${modifier}X`, () => this.clipboardAction('cut'));
    add('Paste', `${modifier}V`, () => this.clipboardAction('paste'));
    add('Clear contents', '', () => this.applyChange({ kind: 'fill', selection: this.selectionRequest()!, value: '' }));
    add('Fill selection…', '', () => this.performTool(() => this.dataTools.fill()));
    add('Find and replace…', '', () => this.performTool(() => this.dataTools.search(true)));
    this.showContextMenu(menu, x, y);
  }

  private openRowMenu(index: number, row: number, x: number, y: number): void {
    this.closeMenu();
    const selected = this.selection.snapshot(this.total, this.visualColumns.length);
    if (!selected || selected.cells || selected.columnCount !== this.visualColumns.length || !selected.ranges.some(range => index >= range.start && index < range.start + range.count)) {
      this.selected = undefined; this.selection.startAxis('rows', index, false); this.paintSelection();
    }
    const menu = document.createElement('div'); menu.className = 'cell-context-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('Row actions'));
    for (const [label, action] of [
      [this.rowPins.includes(row) ? 'Unpin row' : 'Pin to top', () => this.toggleRowPin(row)],
      ['Insert rows above…', () => this.dataTools.insertRows(row)],
      ['Insert rows below…', () => this.dataTools.insertRows(row + 1)],
      ['Delete selected rows…', () => this.dataTools.deleteRows()],
    ] as const) {
      const button = this.button(label, label, () => void this.performTool(action));
      button.setAttribute('role', 'menuitem'); button.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
      menu.append(button);
    }
    this.showContextMenu(menu, x, y);
  }

  private openTableMenu(x: number, y: number): void {
    this.closeMenu();
    const menu = document.createElement('div'); menu.className = 'cell-context-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('Table actions'));
    for (const [label, action] of [
      ['Insert rows…', () => this.dataTools.insertRows()],
      ['Insert column…', () => this.dataTools.insertColumn()],
    ] as const) {
      const button = this.button(label, label, () => void this.performTool(action));
      button.setAttribute('role', 'menuitem'); button.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
      if (label === 'Insert rows…' && !this.metadata?.headers.length) {
        button.disabled = true; button.dataset.tooltip = t('Insert a column before adding rows to an empty file.');
      }
      menu.append(button);
    }
    this.showContextMenu(menu, x, y);
  }

  private showContextMenu(menu: HTMLElement, x: number, y: number): void {
    this.root.append(menu); this.menu = menu;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    menu.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); this.closeMenu(); this.viewport.focus({ preventScroll: true }); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    items[0]?.focus({ preventScroll: true });
  }

  private async selectedOriginalRows(): Promise<number[]> {
    const selection = this.selectionRequest(); if (!selection) throw new Error('Select rows in Table mode first.');
    const ranges = selection.ranges ?? [{ start: selection.start, count: selection.count }];
    if (ranges.reduce((count, range) => count + range.count, 0) > 100000) throw new Error('Select at most 100,000 rows to delete at once.');
    const rows: number[] = [];
    for (const range of ranges) for (let index = range.start; index < range.start + range.count; index += 1000) {
      const page = await this.request({ type: 'page', start: index, count: Math.min(1000, range.start + range.count - index) }) as Page;
      rows.push(...page.rows.map(row => row.id));
    }
    return rows;
  }

  private async selectOriginalIssues(issues: CheckResult['issues']): Promise<void> {
    await this.flushText();
    if (issues.length > 200) throw new Error('Select at most 200 listed results.');
    const unique = [...new Set(issues.map(issue => issue.row))];
    const generation = this.generation;
    const locations = await Promise.all(unique.map(row => this.request({ type: 'locate', row }) as Promise<LocateResult>));
    if (generation !== this.generation) throw new Error('The view changed. Try selecting the results again.');
    const excluded = locations.filter(location => location.index === null).length;
    if (excluded) throw new Error(t('{count} checked rows are excluded by the current filters. Clear filters and try again.', { count: excluded }));
    if (this.textEditor.visible) { await this.textEditor.hide(); this.setTextMode(false); }
    if (generation !== this.generation) throw new Error('The view changed. Try selecting the results again.');
    const hidden = new Set(issues.flatMap(issue => issue.col === undefined ? [] : [issue.col]));
    if (this.state.hidden?.some(col => hidden.has(col))) { this.state.hidden = this.state.hidden.filter(col => !hidden.has(col)); this.persist(); }
    const columns = this.visualColumns;
    const indices = new Map(unique.map((row, index) => [row, locations[index]!.index!]));
    const cells = issues.flatMap(issue => (issue.col === undefined ? columns.map((_, col) => col) : [columns.indexOf(issue.col)]).map(col => ({ row: indices.get(issue.row)!, col })));
    this.selected = undefined; this.selection.selectCells(cells);
    if (locations.length) this.scrollToLogical(this.rowLayout.offset(Math.min(...locations.map(location => location.index!))));
    this.updateSelectionStats(); this.render();
  }

  private async locateRow(row: number, col?: number): Promise<void> {
    await this.flushText();
    const generation = this.generation;
    const location = await this.request({ type: 'locate', row }) as LocateResult;
    if (generation !== this.generation) throw new Error('The view changed. Try locating the result again.');
    if (location.index === null) throw new Error('This row is excluded by the current filters. Clear filters to show it.');
    if (this.textEditor.visible) { await this.textEditor.hide(); this.setTextMode(false); }
    if (col !== undefined && this.state.hidden?.includes(col)) { this.state.hidden = this.state.hidden.filter(index => index !== col); this.persist(); }
    const column = col ?? this.visualColumns[0]; if (column === undefined) return;
    const page = await this.request({ type: 'page', start: location.index, count: 1 }) as Page;
    const record = page.rows[0]; if (!record) throw new Error('This row no longer exists.');
    this.selected = { row: record.id, col: column, index: location.index, value: record.values[column] ?? '' };
    this.selection.start(location.index, this.visualColumns.indexOf(column));
    this.scrollToLogical(this.rowLayout.offset(location.index));
    if (!this.frozen.has(column)) this.viewport.scrollLeft = this.columnSpan(this.visualColumns.slice(0, this.visualColumns.indexOf(column)).filter(item => !this.frozen.has(item)));
    this.updateSelectionStats(); this.render(); this.viewport.focus();
  }

  private button(text: string, title: string, action: () => void, shortcut?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t(text);
    button.dataset.tooltip = title.startsWith('Click:') ? t(title) : t('Click: {action}', { action: t(title) });
    button.dataset.l10nText = text;
    button.dataset.l10nTooltip = title;
    button.dataset.l10nLabel = title;
    button.setAttribute('aria-label', t(title));
    if (shortcut) {
      const mac = /Mac/i.test(navigator.platform);
      button.dataset.shortcut = mac ? `⌘${shortcut.replace('Shift+', '⇧')}` : `Ctrl+${shortcut}`;
      button.setAttribute('aria-keyshortcuts', `${mac ? 'Meta' : 'Control'}+${shortcut}`);
    }
    button.addEventListener('click', action);
    return button;
  }

  private updateLanguage(): void {
    document.documentElement.lang = locale.language;
    this.toolbar.setAttribute('aria-label', t('CSV tools'));
    this.viewport.setAttribute('aria-label', t('CSV data'));
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-l10n-text]')) {
      if (button.dataset.l10nText) {
        const label = button.querySelector('.menu-label');
        if (label) label.textContent = t(button.dataset.l10nText); else button.textContent = t(button.dataset.l10nText);
      }
      if (button.dataset.l10nTooltip) {
        button.dataset.tooltip = button.dataset.l10nTooltip.startsWith('Click:') ? t(button.dataset.l10nTooltip) : t('Click: {action}', { action: t(button.dataset.l10nTooltip) });
        button.setAttribute('aria-label', t(button.dataset.l10nLabel ?? button.dataset.l10nTooltip));
      }
    }
    this.closeMenu(); this.applyTheme();
    this.setTextMode(this.textEditor.visible);
    this.render();
  }

  private iconButton(icon: Icon, title: string, action: () => void): HTMLButtonElement {
    const button = this.button('', title, action); button.classList.add('icon-button');
    this.setIcon(button, icon);
    return button;
  }

  private setIcon(button: HTMLButtonElement, icon: Icon): void {
    const paths = {
      undo: 'M9 5 4 10l5 5 M4 10h9a6 6 0 0 1 6 6v2',
      redo: 'm15 5 5 5-5 5 M20 10h-9a6 6 0 0 0-6 6v2',
      sun: 'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0 M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
      moon: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z',
      filter: 'M4 5h16l-6 7v6l-4 2v-8L4 5Z',
      move: 'M7 5h3 M14 5h3 M7 12h3 M14 12h3 M7 19h3 M14 19h3',
      sort: 'M8 5v14m-4-4 4 4 4-4 M16 19V5m-4 4 4-4 4 4',
      ascending: 'M12 19V5m-5 5 5-5 5 5',
      descending: 'M12 5v14m-5-5 5 5 5-5',
      text: 'M5 5h14M12 5v14M8 19h8',
      table: 'M3 4h18v16H3Z M3 9h18M3 14h18M9 4v16M15 4v16',
      help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M12 17h.01',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[icon]); svg.append(path); button.replaceChildren(svg);
  }

  private request(message: Request): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.vscode.postMessage({ ...message, id } as ClientMessage);
    });
  }

  private message(message: HostMessage): void {
    if (message.type === 'prompt') {
      void this.promptDialog.show(message.prompt).then(value => this.request({ type: 'promptChoice', promptId: message.prompt.id, value })).catch(error => this.showError(error));
    } else if (message.type === 'language') {
      locale.setLanguage(message.language);
    } else if (message.type === 'guide') {
      if (!message.seen && !this.inlineEditor.open && !this.fileDialogs.open) this.guide.show();
    } else if (message.type === 'textRestore') {
      void this.toggleText(message.start);
    } else if (message.type === 'textState') {
      this.textEditor.accept(message.page, message.error);
    } else if (message.type === 'savePrompt') {
      if (this.guide.open) { void this.request({ type: 'saveChoice', choice: null }); return; }
      const choose = async () => {
        if (!(await this.inlineEditor.commit(false))) { await this.request({ type: 'saveChoice', choice: null }); return; }
        const valid = !this.textEditor.visible || await this.textEditor.flush();
        const choice = valid || message.allowDiscard ? await this.fileDialogs.save(message.allowDiscard, valid) : null;
        await this.request({ type: 'saveChoice', choice });
      };
      void choose().catch(error => this.showError(error));
    } else if (message.type === 'viewReset') {
      this.resetStructure(); this.order = this.metadata?.headers.map((_, col) => col) ?? []; this.total = this.metadata?.rows ?? 0;
      this.rowLayout.clear(); this.clearSelection(); this.invalidate(); this.render();
    } else if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result);
    } else if (message.type === 'metadata') this.receiveMetadata(message.data);
    else if (message.type === 'changed') {
      this.dataTools.invalidateChecks();
      this.changes = message.changes;
      this.canUndo = message.canUndo ?? this.canUndo;
      this.canRedo = message.canRedo ?? this.canRedo;
      this.refreshing = false;
      this.invalidate();
      this.schedule();
      void this.textEditor.refresh();
    }
    else if (message.type === 'error') this.showError(new Error(message.message));
  }

  private receiveMetadata(data: Metadata): void {
    const previous = this.metadata;
    if (previous?.complete && !data.complete) this.refreshing = true;
    if (previous && (previous.hasHeader !== data.hasHeader || previous.headers.length !== data.headers.length || previous.headers.some((header, index) => header !== data.headers[index]) || (previous.complete && !data.complete))) this.dataTools?.invalidateChecks();
    this.metadata = data;
    const context = this.measureContext();
    const digitWidth = context ? Math.max(...Array.from('0123456789', digit => context.measureText(digit).width)) : 8;
    this.numberWidth = Math.max(MIN_NUMBER_WIDTH, Math.ceil(String(Math.max(1, data.rows)).length * digitWidth + 40));
    this.root.style.setProperty('--row-number-width', `${this.numberWidth}px`);
    if (data.pinnedRows) this.visibleRowPins = data.pinnedRows;
    if (previous && previous.hasHeader !== data.hasHeader) {
      this.order = data.headers.map((_, i) => i); this.frozen.clear();
      this.query = { filters: [], sort: null }; this.rowLayout.clear(); this.clearSelection(); this.invalidate(); this.persist();
    }
    if (!previous || !this.order.length || previous.headers.length !== data.headers.length) {
      const columns = data.headers.map((_, i) => i);
      const saved = this.state.order ?? [];
      this.order = [...new Set([...saved.filter(col => columns.includes(col)), ...columns])];
      this.frozen = new Set((this.state.frozen ?? []).filter(col => columns.includes(col)));
    }
    this.textEditor?.updateTotal(data.rows + (data.hasHeader && data.headers.length ? 1 : 0));
    if (this.refreshing) { this.renderStatus(); return; }
    if (!this.query.sort && !this.query.filters.length) this.total = data.rows;
    if (previous && data.rows < previous.rows) this.invalidate();
    else if (previous && data.rows > previous.rows) {
      const tail = Math.floor(previous.rows / PAGE_SIZE) * PAGE_SIZE;
      for (const page of this.pages.values()) if (page.start >= tail) this.removePage(page.start);
    }
    this.render();
  }

  private applyTheme(): void {
    const dark = this.state.theme ? this.state.theme === 'dark' : !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    this.setIcon(this.themeButton, dark ? 'sun' : 'moon');
    this.themeButton.dataset.tooltip = t('Click: switch to {target} theme', { target: t(dark ? 'light' : 'dark') });
    this.themeButton.setAttribute('aria-label', t('Theme: {theme} · Switch to {target}', { theme: this.state.theme ? t(this.state.theme === 'dark' ? 'Dark' : 'Light') : 'VS Code', target: t(dark ? 'light' : 'dark') }));
  }

  private persist(): void {
    this.state = { ...this.state, order: this.order, frozen: [...this.frozen] };
    this.vscode.setState(this.state);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; this.render(); });
  }

  private get visualColumns(): number[] {
    const hidden = new Set(this.state.hidden ?? []);
    return [...this.order.filter(col => this.frozen.has(col)), ...this.order.filter(col => !this.frozen.has(col))].filter(col => !hidden.has(col));
  }

  private width(col: number): number { return Math.max(MIN_WIDTH, this.state.widths?.[col] ?? DEFAULT_WIDTH); }

  private columnSpan(columns: number[]): number { return columns.reduce((sum, col) => sum + this.width(col), 0); }
  private get columnPositions(): { col: number; left: number; width: number; frozen: boolean }[] {
    let offset = this.numberWidth;
    return this.visualColumns.map(col => {
      const frozen = this.frozen.has(col), width = this.width(col);
      const item = { col, left: offset - (frozen ? 0 : this.viewport.scrollLeft), width, frozen };
      offset += width;
      return item;
    });
  }
  private get columnLayout(): { col: number; left: number; width: number; frozen: boolean }[] {
    const pinnedWidth = this.numberWidth + this.columnSpan(this.visualColumns.filter(col => this.frozen.has(col)));
    return this.columnPositions.filter(item => item.left < this.viewport.clientWidth && (item.frozen || item.left + item.width > pinnedWidth));
  }

  private render(): void {
    if (this.textEditor?.visible) { this.renderStatus(); return; }
    this.measureVisibleRows();
    const contentHeight = this.displayContentHeight;
    const height = Math.max(this.viewport.clientHeight, Math.min(MAX_HEIGHT, contentHeight));
    this.canvas.style.height = `${height}px`;
    this.canvas.style.width = `${Math.max(this.viewport.clientWidth, this.numberWidth + this.columnSpan(this.visualColumns))}px`;
    this.viewport.setAttribute('aria-rowcount', String(this.total));
    this.viewport.setAttribute('aria-colcount', String(this.visualColumns.length));
    const logicalTop = this.logicalScrollTop;
    const first = this.rowLayout.rowAt(logicalTop, this.total);
    const pinCount = this.visibleRowPins.length;
    const start = Math.max(pinCount, first - 3);
    const end = Math.min(this.total, this.rowLayout.rowAt(logicalTop + this.viewport.clientHeight - this.pinnedViewportHeight, this.total) + 5);
    this.heading.style.width = `${this.viewport.clientWidth}px`;
    const layout = this.columnLayout;
    if (this.dragged === undefined && !this.resizing) this.renderHeadings(layout);
    const fragment = document.createDocumentFragment();
    const pinned = document.createElement('div'); pinned.className = 'pinned-rows';
    pinned.style.width = `${this.viewport.clientWidth}px`; pinned.style.height = `${this.pinnedViewportHeight}px`;
    pinned.setAttribute('aria-label', t('Pinned rows'));
    pinned.addEventListener('scroll', () => { this.pinnedScrollTop = pinned.scrollTop; this.closeMenu(); }, { passive: true });
    const indices = [...Array.from({ length: pinCount }, (_, index) => index), ...Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index)];
    for (const index of indices) {
      const pageStart = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
      const page = this.pageAt(index);
      if (page) { this.pages.delete(page.start); this.pages.set(page.start, page); }
      const row = page?.rows[index - page.start];
      if (!row) this.loadPage(this.pages.has(pageStart) ? index : pageStart);
      const rowElement = document.createElement('div');
      rowElement.className = 'grid-row';
      const isPinned = index < pinCount;
      rowElement.classList.toggle('pinned', isPinned);
      rowElement.setAttribute('role', 'row');
      rowElement.setAttribute('aria-rowindex', String(index + 2));
      rowElement.style.top = `${isPinned ? this.rowLayout.offset(index) : this.rowLayout.offset(index) - logicalTop + this.pinnedViewportHeight + this.viewport.scrollTop}px`;
      rowElement.style.height = `${this.rowLayout.height(index)}px`;
      const number = document.createElement('div');
      number.className = 'cell row-number';
      number.textContent = row ? String(row.id + 1) : '…';
      number.setAttribute('role', 'rowheader');
      const resize = document.createElement('div');
      resize.className = 'row-resize'; resize.dataset.tooltip = t(this.selection.isAll(this.total, this.visualColumns.length) ? 'Double-click: fit all rows as they become visible' : 'Drag: resize row · Double-click: fit loaded content');
      resize.addEventListener('pointerdown', event => this.resizeRow(event, index, resize));
      resize.addEventListener('dblclick', event => { event.stopPropagation(); if (this.selection.isAll(this.total, this.visualColumns.length)) { this.fitAllRows(); } else if (row) this.fitRow(index, row.values); });
      number.dataset.index = String(index);
      number.tabIndex = 0;
      number.dataset.tooltip = t('Click: select row · Drag: select rows · Right-click: insert or delete rows');
      number.addEventListener('contextmenu', event => {
        if (!row) return;
        event.preventDefault(); event.stopPropagation();
        if (!this.clipboard.busy) this.openRowMenu(index, row.id, event.clientX, event.clientY);
      });
      number.addEventListener('keydown', event => {
        if (!row || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return;
        event.preventDefault(); event.stopPropagation();
        const rect = number.getBoundingClientRect(); this.openRowMenu(index, row.id, rect.left, rect.bottom);
      });
      const rowSelection = this.selection.snapshot(this.total, this.visualColumns.length);
      number.classList.toggle('axis-selected', Boolean(rowSelection && !rowSelection.cells && rowSelection.columnCount === this.visualColumns.length && rowSelection.ranges.some(range => index >= range.start && index < range.start + range.count)));
      number.addEventListener('pointerdown', event => {
        if (event.button !== 0 || (event.target as Element).closest('.row-resize, .row-drag-handle')) return;
        this.beginAxisSelection(event, 'rows', index);
      });
      if (row) {
        const move = this.iconButton('move', t('Move row {number}', { number: row.id + 1 }), () => {});
        move.classList.add('row-drag-handle');
        move.disabled = Boolean(!this.metadata?.complete || this.operation || this.clipboardStatus);
        move.dataset.tooltip = t(this.query.sort || this.query.filters.length ? 'Double-click: pin or unpin · Clear sorting and filters: drag rows' : 'Drag: reorder row · Double-click: pin or unpin');
        move.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); void this.toggleRowPin(row.id); });
        move.addEventListener('click', event => { if (event.detail === 0) { event.preventDefault(); event.stopPropagation(); void this.toggleRowPin(row.id); } });
        this.rowDrag.attach(move, row.id); number.append(move);
      }
      number.append(resize); rowElement.append(number);
      for (const item of layout) {
        const cell = document.createElement('div');
        cell.className = `cell${item.frozen ? ' frozen' : ''}`;
        cell.classList.toggle('expanded', this.rowLayout.height(index) > 30);
        cell.style.width = `${item.width}px`;
        cell.style.left = `${isPinned || item.frozen ? item.left : item.left + this.viewport.scrollLeft}px`;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-colindex', String(this.visualColumns.indexOf(item.col) + 1));
        cell.dataset.col = String(item.col);
        cell.dataset.index = String(index);
        this.paintCellSelection(cell, index, this.visualColumns.indexOf(item.col));
        if (row) {
          cell.dataset.row = String(row.id);
          cell.classList.toggle('modified', row.modified.includes(item.col) || Boolean(row.inserted) || Boolean(this.metadata?.insertedColumns?.includes(item.col)));
          const value = row.values[item.col] ?? '';
          this.renderValue(cell, value, this.rowLayout.height(index) > 30);
          cell.dataset.tooltip = t('Click and drag: select cells · Double-click: edit · Right-click: options');
          cell.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const column = this.visualColumns.indexOf(item.col);
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
              event.preventDefault(); window.getSelection()?.removeAllRanges();
              try {
                if (event.ctrlKey || event.metaKey) this.selection.toggle(index, column, this.total, this.visualColumns.length);
                else this.selection.extend(index, column);
                this.selected = { row: row.id, col: item.col, index, value };
                this.paintSelection(); this.viewport.focus({ preventScroll: true });
              } catch (error) { this.showError(error); }
              return;
            }
            event.preventDefault(); window.getSelection()?.removeAllRanges();
            this.selected = { row: row.id, col: item.col, index, value };
            if (event.shiftKey && this.selection.bounds) this.selection.extend(index, column);
            else this.selection.start(index, column);
            this.selecting = true; this.selectionMoved = false; this.selectionOrigin = { x: event.clientX, y: event.clientY };
            this.pointer = { x: event.clientX, y: event.clientY };
            this.viewport.focus({ preventScroll: true });
            this.paintSelection();
            this.startAutoScroll();
          });
          cell.addEventListener('dblclick', event => { event.preventDefault(); clearTimeout(this.pendingLink); this.pendingLink = undefined; void this.openCell({ row: row.id, col: item.col, index, value }); });
        } else cell.classList.add('loading-cell');
        rowElement.append(cell);
      }
      (isPinned ? pinned : fragment).append(rowElement);
    }
    if (pinCount) fragment.append(pinned);
    this.canvas.replaceChildren(fragment);
    if (pinCount) pinned.scrollTop = this.pinnedScrollTop;
    if (!this.total) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = t(this.metadata?.complete ? (this.query.filters.length ? 'No matching rows' : 'No data rows') : 'Opening CSV…');
      this.canvas.append(empty);
    }
    this.updateSelectionStats();
  }

  private renderHeadings(layout: { col: number; left: number; width: number; frozen: boolean }[]): void {
    const fragment = document.createDocumentFragment();
    const corner = document.createElement('div');
    corner.className = 'column-heading corner';
    corner.textContent = t('#');
    corner.setAttribute('role', 'button'); corner.tabIndex = 0;
    corner.setAttribute('aria-label', t('Select all cells'));
    corner.dataset.tooltip = t('Click: select all cells · Right-click: insert rows or columns');
    corner.classList.toggle('axis-selected', this.selection.isAll(this.total, this.visualColumns.length));
    corner.addEventListener('click', () => this.selectAllCells());
    corner.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); this.openTableMenu(event.clientX, event.clientY); });
    corner.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.selectAllCells(); }
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); const rect = corner.getBoundingClientRect(); this.openTableMenu(rect.left, rect.bottom);
      }
    });
    fragment.append(corner);
    for (const item of layout) {
      const heading = document.createElement('div');
      heading.className = `column-heading${item.frozen ? ' frozen' : ''}`;
      heading.classList.toggle('modified', this.metadata?.modifiedHeaders?.includes(item.col) ?? false);
      heading.dataset.col = String(item.col);
      heading.style.width = `${item.width}px`;
      heading.style.left = `${item.left}px`;
      heading.draggable = false;
      heading.setAttribute('role', 'columnheader');
      if (this.query.sort?.col === item.col) heading.setAttribute('aria-sort', this.query.sort.direction === 1 ? 'ascending' : 'descending');
      const label = document.createElement('span');
      label.className = 'column-label';
      label.textContent = this.metadata?.headers[item.col] || t('Column {number}', { number: item.col + 1 });
      const filtered = this.query.filters.some(filter => filter.col === item.col);
      const sort = this.query.sort?.col === item.col ? (this.query.sort.direction === 1 ? ' ↑' : ' ↓') : '';
      heading.classList.toggle('filtered', filtered);
      label.dataset.tooltip = t(this.metadata?.hasHeader ? 'Drag: select columns · Double-click: edit header · Right-click: column options' : 'Drag: select columns · Use First row as headers to edit column names');
      heading.addEventListener('dblclick', event => {
        if ((event.target as Element).closest('button, .column-resize')) return;
        event.preventDefault(); event.stopPropagation(); void this.openHeader(item.col);
      });
      heading.dataset.tooltip = label.dataset.tooltip;
      const trigger = this.iconButton('filter', t('Filter {column}', { column: label.textContent ?? '' }), () => this.toggleColumnMenu('filter', item.col, trigger));
      trigger.classList.add('column-filter-button');
      trigger.dataset.tooltip = t('Click: filter this column');
      const sortButton = this.iconButton(sort.trim() === '↑' ? 'ascending' : sort.trim() === '↓' ? 'descending' : 'sort', t('Sort {column}', { column: label.textContent ?? '' }), () => this.toggleColumnMenu('sort', item.col, sortButton));
      sortButton.addEventListener('dblclick', event => {
        event.preventDefault(); event.stopPropagation(); this.closeMenu();
        const current = this.query.sort?.col === item.col ? this.query.sort : null;
        const next = current?.direction === -1 ? null : { col: item.col, direction: current ? -1 as const : 1 as const, numeric: this.state.sortTypes?.[item.col] ?? 'auto' };
        void this.setQuery({ ...this.query, sort: next });
      });
      sortButton.classList.add('column-sort-button');
      sortButton.classList.toggle('active', this.query.sort?.col === item.col);
      sortButton.setAttribute('aria-pressed', String(this.query.sort?.col === item.col));
      trigger.setAttribute('aria-pressed', String(filtered));
      sortButton.dataset.tooltip = t('Click: sort options · Double-click: change sort direction');
      sortButton.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
      sortButton.addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation(); this.openSortMenu(item.col, sortButton, { x: event.clientX, y: event.clientY });
      });
      sortButton.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault(); event.stopPropagation(); this.openSortMenu(item.col, sortButton);
      });
      const resize = document.createElement('div');
      resize.className = 'column-resize'; resize.setAttribute('role', 'separator');
      resize.setAttribute('aria-orientation', 'vertical'); resize.tabIndex = 0;
      resize.setAttribute('aria-label', t('Resize {column}', { column: label.textContent ?? '' }));
      resize.dataset.tooltip = t(this.selection.isAll(this.total, this.visualColumns.length) ? 'Double-click: fit all columns using loaded samples' : 'Drag: resize column · Double-click: fit loaded content');
      resize.addEventListener('pointerdown', event => this.resizeColumn(event, item.col, resize));
      resize.addEventListener('dblclick', event => { event.stopPropagation(); this.fitColumn(item.col); });
      resize.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;
        event.preventDefault(); if (event.key === 'Enter') this.fitColumn(item.col);
        else this.setWidth(item.col, this.width(item.col) + (event.key === 'ArrowLeft' ? -20 : 20));
      });
      const move = this.iconButton('move', t('Move {column}', { column: label.textContent ?? '' }), () => {});
      move.classList.add('column-drag-handle'); move.draggable = true;
      move.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); this.togglePin([item.col]); });
      move.addEventListener('click', event => { if (event.detail === 0) { event.preventDefault(); event.stopPropagation(); this.togglePin([item.col]); } });
      move.dataset.tooltip = t('Drag: reorder column · Double-click: pin or unpin');
      move.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
      if (!this.metadata?.complete) move.dataset.tooltip = t('Wait for indexing to finish before reordering columns');
      heading.addEventListener('pointerdown', event => {
        if (event.button !== 0 || (event.target as Element).closest('button, .column-resize')) return;
        this.beginAxisSelection(event, 'columns', this.visualColumns.indexOf(item.col));
      });
      heading.tabIndex = 0;
      heading.addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation();
        this.openMenu(item.col, heading, { x: event.clientX, y: event.clientY });
      });
      heading.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault(); event.stopPropagation();
        const rect = heading.getBoundingClientRect();
        this.openMenu(item.col, heading, { x: rect.left, y: rect.bottom });
      });
      heading.append(label, sortButton, trigger, move, resize);
      heading.addEventListener('dragstart', event => {
        if (this.resizing || move.disabled || !(event.target as Element).closest('.column-drag-handle')) { event.preventDefault(); return; }
        this.dragged = item.col;
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(item.col)); }
        this.createDragImage(item.col, heading, event);
        heading.classList.add('dragging'); this.closeMenu();
      });
      const updateDropTarget = (event: DragEvent) => {
        if (this.dragged === undefined) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        for (const target of this.heading.querySelectorAll('.drop-target')) target.classList.remove('drop-target', 'drop-before', 'drop-after');
        this.dropAfter = event.clientX > heading.getBoundingClientRect().left + heading.clientWidth / 2;
        heading.classList.toggle('drop-before', !this.dropAfter);
        heading.classList.toggle('drop-after', this.dropAfter);
        heading.classList.add('drop-target');
      };
      heading.addEventListener('dragenter', updateDropTarget);
      heading.addEventListener('dragover', updateDropTarget);

      heading.addEventListener('dragleave', event => {
        if (event.relatedTarget instanceof Node && heading.contains(event.relatedTarget)) return;
        const rect = heading.getBoundingClientRect();
        if (event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) return;
        heading.classList.remove('drop-target', 'drop-before', 'drop-after');
      });
      heading.addEventListener('dragend', () => this.endDrag());
      heading.addEventListener('drop', event => {
        event.preventDefault();
        const dragged = this.dragged, after = this.dropAfter; this.endDrag();
        if (dragged === undefined || dragged === item.col) return;
        void this.applyChange({ kind: 'moveColumn', col: dragged, before: item.col + (after ? 1 : 0) }).catch(error => this.showError(error));
      });
      fragment.append(heading);
    }
    this.heading.replaceChildren(fragment);
    const selected = this.selection.snapshot(this.total, this.visualColumns.length);
    for (const heading of this.heading.querySelectorAll<HTMLElement>('[data-col]')) heading.classList.toggle('axis-selected', Boolean(selected && !selected.cells && selected.rowCount === this.total && selected.columns.includes(this.visualColumns.indexOf(Number(heading.dataset.col)))));
  }

  private get pinnedHeight(): number { const count = this.visibleRowPins.length; return count ? this.rowLayout.offset(count) : 0; }
  private get pinnedViewportHeight(): number { return Math.min(this.pinnedHeight, Math.floor(this.viewport.clientHeight / 2)); }
  private get displayContentHeight(): number { return this.rowLayout.offset(this.total) - this.pinnedHeight + this.pinnedViewportHeight; }

  private get logicalScrollTop(): number {
    const totalHeight = this.displayContentHeight;
    const range = Math.max(1, Math.min(MAX_HEIGHT, totalHeight) - this.viewport.clientHeight);
    return this.pinnedHeight + this.viewport.scrollTop / range * Math.max(0, totalHeight - this.viewport.clientHeight);
  }

  private scrollToLogical(top: number): void {
    if (top < this.pinnedHeight) this.pinnedScrollTop = Math.max(0, Math.min(top, this.pinnedHeight - this.pinnedViewportHeight));
    const totalHeight = this.displayContentHeight;
    const logicalRange = Math.max(1, totalHeight - this.viewport.clientHeight);
    this.viewport.scrollTop = Math.max(0, top - this.pinnedHeight) / logicalRange * Math.max(0, Math.min(MAX_HEIGHT, totalHeight) - this.viewport.clientHeight);
  }

  private resizeRow(event: PointerEvent, index: number, handle: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const start = event.clientY, height = this.rowLayout.height(index);
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      this.setRowHeight(index, height + next.clientY - start);
    };
    const finish = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish);
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish);
  }

  private setRowHeight(index: number, height: number): void {
    const top = this.logicalScrollTop;
    this.rowLayout.set(index, height);
    this.canvas.style.height = `${Math.max(this.viewport.clientHeight, Math.min(MAX_HEIGHT, this.displayContentHeight))}px`;
    this.scrollToLogical(top); this.render();
  }

  private fitRow(index: number, values: string[]): void {
    const context = this.measureContext();
    if (context) this.setRowHeight(index, this.rowContentHeight(values, context));
  }

  private measureContext(): CanvasRenderingContext2D | null {
    const context = document.createElement('canvas').getContext('2d');
    if (context) context.font = getComputedStyle(this.viewport).font;
    return context;
  }

  private resetRowMeasurements(): void {
    if (!this.rowLayout.autoFit) return;
    const top = this.logicalScrollTop, anchor = this.rowLayout.rowAt(top, this.total);
    const within = top - this.rowLayout.offset(anchor);
    this.rowLayout.resetMeasurements();
    this.canvas.style.height = `${Math.max(this.viewport.clientHeight, Math.min(MAX_HEIGHT, this.displayContentHeight))}px`;
    this.scrollToLogical(this.rowLayout.offset(anchor) + within);
  }

  private fitAllRows(): void {
    const top = this.logicalScrollTop, anchor = this.rowLayout.rowAt(top, this.total);
    this.rowLayout.fitAll();
    this.canvas.style.height = `${Math.max(this.viewport.clientHeight, Math.min(MAX_HEIGHT, this.displayContentHeight))}px`;
    this.scrollToLogical(this.rowLayout.offset(anchor)); this.render();
  }

  private measureVisibleRows(): void {
    if (!this.rowLayout.autoFit || !this.total) return;
    const top = this.logicalScrollTop;
    const anchor = this.rowLayout.rowAt(top, this.total), within = top - this.rowLayout.offset(anchor);
    const end = Math.min(this.total, this.rowLayout.rowAt(top + this.viewport.clientHeight, this.total) + 5);
    const context = this.measureContext();
    if (!context) return;
    const deadline = performance.now() + 8;
    const pinCount = this.visibleRowPins.length, start = Math.max(pinCount, anchor - 3);
    const indices = [...Array.from({ length: pinCount }, (_, index) => index), ...Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index)];
    for (const index of indices) {
      if (!this.rowLayout.needsMeasurement(index)) continue;
      const page = this.pageAt(index), row = page?.rows[index - page.start];
      if (!row) continue;
      this.rowLayout.set(index, this.rowContentHeight(row.values, context));
      if (performance.now() >= deadline) { this.schedule(); break; }
    }
    this.canvas.style.height = `${Math.max(this.viewport.clientHeight, Math.min(MAX_HEIGHT, this.displayContentHeight))}px`;
    this.scrollToLogical(this.rowLayout.offset(anchor) + within);
  }

  private rowContentHeight(values: string[], context: CanvasRenderingContext2D): number {
    let lines = 1;
    for (const col of this.visualColumns) {
      const wrapped = (values[col] ?? '').slice(0, 4096).split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(context.measureText(line).width / Math.max(1, this.width(col) - 20))), 0);
      lines = Math.max(lines, wrapped);
    }
    return lines * 17 + 12;
  }

  private setWidth(col: number, width: number): void {
    this.state.widths = { ...this.state.widths, [col]: Math.max(MIN_WIDTH, Math.min(800, Math.round(width))) };
    this.resetRowMeasurements(); this.persist(); this.render();
  }

  private resizeColumn(event: PointerEvent, col: number, handle: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); this.closeMenu();
    const start = event.clientX, width = this.width(col);
    this.resizing = true; handle.setPointerCapture(event.pointerId);
    let moved = false;
    const move = (next: PointerEvent) => {
      if (!moved && Math.abs(next.clientX - start) < 3) return;
      moved = true;
      this.state.widths = { ...this.state.widths, [col]: Math.max(MIN_WIDTH, Math.min(800, width + next.clientX - start)) };
      this.resetRowMeasurements(); this.render();
      for (const heading of this.heading.querySelectorAll<HTMLElement>('[data-col]')) {
        const item = this.columnLayout.find(item => item.col === Number(heading.dataset.col));
        if (item) { heading.style.width = `${item.width}px`; heading.style.left = `${item.left}px`; }
      }
    };
    const finish = () => {
      this.resizing = false; handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish);
      if (moved) { this.persist(); this.render(); }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  }

  private fitColumn(col: number): void {
    const context = this.measureContext();
    if (!context) return;
    const columns = this.selection.isAll(this.total, this.visualColumns.length) ? this.visualColumns : [col];
    const widths: Record<number, number> = {};
    for (const column of columns) widths[column] = context.measureText(this.metadata?.headers[column] ?? '').width + 84;
    let rows = 0, bytes = 0;
    sample: for (const page of [...this.pages.values()].reverse()) for (let index = 0; index < page.rows.length; index++) {
      if (++rows > 1000) break sample;
      const row = page.rows[index]!;
      for (const column of columns) {
        bytes += Math.max(16, this.pageCellBytes.get(page.start)?.[index]?.[column] ?? 0);
        if (bytes > 256 * 1024) break sample;
        const value = (row.values[column] ?? '').slice(0, 1000).replace(/\r?\n/g, ' ↵ ');
        widths[column] = Math.max(widths[column]!, context.measureText(value).width + 24);
      }
    }
    this.state.widths = { ...this.state.widths, ...Object.fromEntries(Object.entries(widths).map(([column, width]) => [column, Math.max(MIN_WIDTH, Math.min(800, Math.round(width)))])) };
    this.resetRowMeasurements(); this.persist(); this.render();
  }

  private createDragImage(col: number, heading: HTMLElement, event: DragEvent): void {
    this.dragImage?.remove();
    const image = document.createElement('div'); image.className = 'column-drag-image';
    image.style.width = `${this.width(col)}px`;
    const viewport = this.viewport.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const headerHeight = this.heading.getBoundingClientRect().height;
    image.style.height = `${headerHeight + this.viewport.clientHeight}px`;
    const header = heading.cloneNode(true) as HTMLElement;
    header.style.position = 'absolute'; header.style.left = '0'; header.style.top = '0'; image.append(header);
    const body = document.createElement('div'); body.className = 'column-drag-body';
    body.style.top = `${headerHeight}px`; body.style.height = `${this.viewport.clientHeight}px`; image.append(body);
    for (const row of this.canvas.children) {
      const cell = row.querySelector<HTMLElement>(`[data-col="${col}"]`);
      if (!cell) continue;
      const rect = cell.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.top + this.viewport.clientHeight) continue;
      const copy = cell.cloneNode(true) as HTMLElement;
      copy.classList.remove('frozen', 'selected'); copy.style.position = 'absolute'; copy.style.left = '0';
      copy.style.top = `${rect.top - viewport.top}px`; copy.style.height = `${rect.height}px`; body.append(copy);
    }
    this.root.append(image); this.dragImage = image;
    event.dataTransfer?.setDragImage(image, Math.min(this.width(col) - 1, Math.max(0, event.clientX - headingRect.left)), Math.max(0, event.clientY - headingRect.top));
  }

  private endDrag(): void {
    this.dragged = undefined;
    for (const heading of this.heading.querySelectorAll('.dragging, .drop-target')) heading.classList.remove('dragging', 'drop-target', 'drop-before', 'drop-after');
    this.dragImage?.remove(); this.dragImage = undefined;
  }

  private clearSelection(): void {
    this.selected = undefined; this.selection.clear(); this.selecting = false; this.axisSelecting = undefined;
    this.updateSelectionStats();
  }

  private paintCellSelection(cell: HTMLElement, row: number, col: number): void {
    const source = this.clipboardMarker?.selection, visual = this.visualColumns;
    const contains = (index: number, column: number) => Boolean(source && (source.cells ? source.cells.some(cell => cell.row === index && cell.col === visual[column]) : column >= 0 && column < visual.length && source.columns.includes(visual[column]!) && (source.ranges ?? [{ start: source.start, count: source.count }]).some(range => index >= range.start && index < range.start + range.count)));
    const copied = contains(row, col);
    cell.classList.toggle('clipboard-source', copied);
    cell.classList.toggle('clipboard-cut', copied && this.clipboardMarker?.mode === 'cut');
    let outline = cell.querySelector<HTMLElement>('.clipboard-outline');
    if (copied && !outline) { outline = document.createElement('span'); outline.className = 'clipboard-outline'; outline.setAttribute('aria-hidden', 'true'); cell.append(outline); }
    if (!copied) outline?.remove();
    for (const [edge, boundary] of Object.entries({ top: !contains(row - 1, col), bottom: !contains(row + 1, col), left: !contains(row, col - 1), right: !contains(row, col + 1) })) cell.classList.toggle(`clipboard-${edge}`, copied && boundary);

    const active = this.selection.contains(row, col);
    cell.classList.toggle('selected', active);
    cell.setAttribute('aria-selected', String(active));
    const edges = {
      top: row === 0 || !this.selection.contains(row - 1, col),
      bottom: row === this.total - 1 || !this.selection.contains(row + 1, col),
      left: col === 0 || !this.selection.contains(row, col - 1),
      right: col === this.visualColumns.length - 1 || !this.selection.contains(row, col + 1),
    };
    for (const [edge, boundary] of Object.entries(edges)) cell.classList.toggle(`selection-${edge}`, active && boundary);
  }

  private paintSelection(): void {
    const columns = this.visualColumns;
    const all = this.selection.isAll(this.total, columns.length);
    this.heading.querySelector('.corner')?.classList.toggle('axis-selected', all);
    for (const separator of this.heading.querySelectorAll<HTMLElement>('.column-resize')) separator.dataset.tooltip = t(all ? 'Double-click: fit all columns using loaded samples' : 'Drag: resize column · Double-click: fit loaded content');
    for (const separator of this.canvas.querySelectorAll<HTMLElement>('.row-resize')) separator.dataset.tooltip = t(all ? 'Double-click: fit all rows as they become visible' : 'Drag: resize row · Double-click: fit loaded content');
    for (const cell of this.canvas.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      this.paintCellSelection(cell, Number(cell.dataset.index), columns.indexOf(Number(cell.dataset.col)));
    }
    const selected = this.selection.snapshot(this.total, this.visualColumns.length);
    for (const heading of this.heading.querySelectorAll<HTMLElement>('[data-col]')) {
      heading.classList.toggle('axis-selected', Boolean(selected && !selected.cells && selected.rowCount === this.total && selected.columns.includes(columns.indexOf(Number(heading.dataset.col)))));
    }
    for (const number of this.canvas.querySelectorAll<HTMLElement>('.row-number')) {
      number.classList.toggle('axis-selected', Boolean(selected && !selected.cells && selected.columnCount === columns.length && selected.ranges.some(range => Number(number.dataset.index) >= range.start && Number(number.dataset.index) < range.start + range.count)));
    }
    this.updateSelectionStats();
  }

  private beginAxisSelection(event: PointerEvent, axis: 'rows' | 'columns', index: number): void {
    if (!this.total || !this.visualColumns.length) return;
    event.preventDefault(); window.getSelection()?.removeAllRanges(); this.closeMenu();
    this.selected = undefined; this.selection.startAxis(axis, index, event.ctrlKey || event.metaKey, event.shiftKey);
    this.selecting = true; this.axisSelecting = axis; this.pointer = { x: event.clientX, y: event.clientY };
    this.viewport.focus({ preventScroll: true }); this.paintSelection(); this.startAutoScroll();
  }

  private moveSelection(event: PointerEvent): void {
    if (!this.selecting) return;
    if (this.selectionOrigin && Math.hypot(event.clientX - this.selectionOrigin.x, event.clientY - this.selectionOrigin.y) > 3) this.selectionMoved = true;
    this.pointer = { x: event.clientX, y: event.clientY };
    this.extendAtPointer();
  }

  private extendAtPointer(): void {
    if (!this.pointer) return;
    const rect = this.viewport.getBoundingClientRect();
    if (this.axisSelecting === 'columns') {
      const heading = document.elementFromPoint(Math.max(1, Math.min(window.innerWidth - 1, this.pointer.x)), this.heading.getBoundingClientRect().top + 15)?.closest<HTMLElement>('.column-heading[data-col]');
      if (heading) { this.selection.extendAxis(this.visualColumns.indexOf(Number(heading.dataset.col))); this.paintSelection(); }
      return;
    }
    if (this.axisSelecting === 'rows') {
      const number = document.elementFromPoint(rect.left + 20, Math.max(rect.top + 2, Math.min(rect.bottom - 16, this.pointer.y)))?.closest<HTMLElement>('.row-number[data-index]');
      if (number) { this.selection.extendAxis(Number(number.dataset.index)); this.paintSelection(); }
      return;
    }
    const x = Math.max(rect.left + 2, Math.min(rect.right - 16, this.pointer.x));
    const y = Math.max(rect.top + 2, Math.min(rect.bottom - 16, this.pointer.y));
    const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('[role="gridcell"]');
    if (!cell || !this.canvas.contains(cell)) return;
    const row = Number(cell.dataset.index), col = this.visualColumns.indexOf(Number(cell.dataset.col));
    const bounds = this.selection.bounds;
    if (bounds && (row !== bounds.firstRow || col !== bounds.firstCol)) this.selectionMoved = true;
    this.selection.extend(row, col); this.paintSelection();
  }

  private startAutoScroll(): void {
    if (this.autoScroll !== undefined) return;
    const tick = () => {
      if (!this.selecting || !this.pointer) { this.autoScroll = undefined; return; }
      const rect = this.viewport.getBoundingClientRect();
      const delta = (value: number, low: number, high: number) => value < low + 24 ? -15 : value > high - 24 ? 15 : 0;
      const dx = this.axisSelecting === 'rows' ? 0 : delta(this.pointer.x, rect.left, rect.right), dy = this.axisSelecting === 'columns' ? 0 : delta(this.pointer.y, rect.top, rect.bottom);
      if (dx || dy) { this.viewport.scrollBy(dx, dy); this.extendAtPointer(); }
      this.autoScroll = requestAnimationFrame(tick);
    };
    this.autoScroll = requestAnimationFrame(tick);
  }

  private renderValue(cell: HTMLElement, value: string, expanded: boolean): void {
    const content = document.createElement('span'); content.className = 'cell-text';
    const limit = Math.min(value.length, expanded ? 4096 : 1000);
    const preview = value.slice(0, limit);
    const pattern = /https?:\/\/[^\s<>"'，。！？；：、…“”‘’《》〈〉「」『』【】（）]+/giu;
    const appendText = (text: string) => content.append(document.createTextNode(expanded ? text : text.replace(/\r?\n/g, ' ↵ ')));
    let end = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index! >= limit) break;
      let url = match[0].replace(/[.,;:!?]+$/, '');
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        while (url.endsWith(close!) && url.split(close!).length > url.split(open!).length) url = url.slice(0, -1);
      }
      if (value.length > 4096 && match.index! + match[0].length >= 4096) continue;
      try { if (!new URL(url).hostname) continue; } catch { continue; }
      appendText(preview.slice(end, match.index));
      const link = document.createElement('a');
      link.textContent = url.slice(0, limit - match.index!); link.href = url; link.draggable = false;
      link.dataset.tooltip = t('Click: open link · Double-click: edit and copy text · Right-click: options · Drag: select cells');
      link.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !this.selectionMoved && event.detail < 2) {
          clearTimeout(this.pendingLink);
          this.pendingLink = setTimeout(() => { this.pendingLink = undefined; if (!this.selectionMoved && !this.operation && !this.inlineEditor.open && !this.textEditor.visible && !this.guide.open && !this.promptDialog.open && !this.fileDialogs.open) void this.run({ type: 'openLink', url }); }, 250);
        }
      });
      content.append(link); end = match.index! + url.length;
    }
    appendText(preview.slice(end));
    cell.append(content);
  }

  private async toggleHeader(): Promise<void> {
    if (!(await this.inlineEditor.commit(false))) return;
    if (this.changes) { this.showError(new Error('Save your changes before switching column headers.')); return; }
    if (!this.metadata?.complete || this.operation) return;
    this.operation = 'Updating headers…'; this.renderStatus(); this.closeMenu();
    try {
      await this.request({ type: 'header', enabled: !this.metadata.hasHeader });
      this.error = '';
    } catch (error) { this.showError(error); }
    finally { this.operation = ''; this.renderStatus(); }
  }

  private loadPage(start: number): void {
    if ([...this.loading].some(pending => start >= pending && start < pending + PAGE_SIZE) || this.failed.has(start) || this.loading.size >= 3) return;
    this.loading.add(start);
    const generation = this.generation;
    void this.request({ type: 'page', start, count: PAGE_SIZE }).then(result => {
      if (generation !== this.generation) return;
      const response = result as Page;
      if (!response || !Array.isArray(response.rows)) return;
      if (response.pinnedRows) this.visibleRowPins = response.pinnedRows;
      if (this.metadata) this.metadata = { ...this.metadata, insertedColumns: response.insertedColumns ?? [] };
      const page: Page = { ...response, rows: response.rows.map(row => ({ ...row, values: row.values.map(value => value.length > 4096 ? `${value.slice(0, 4096)}…` : value) })) };
      this.removePage(start);
      this.pages.set(start, page);
      const encoder = new TextEncoder();
      this.pageCellBytes.set(start, response.rows.map(row => row.values.map(value => encoder.encode(value).byteLength)));
      const bytes = page.rows.reduce((sum, row) => sum + row.values.reduce((size, value) => size + value.length * 2 + 32, 64), 0);
      this.pageBytes.set(start, bytes);
      this.cachedBytes += bytes;
      while (this.pages.size > 1 && (this.pages.size > 12 || this.cachedBytes > 24 * 1024 * 1024)) this.removePage(this.pages.keys().next().value!);
      this.total = page.total;
    }).catch(error => {
      if (generation === this.generation) { this.failed.add(start); this.showError(error); }
    }).finally(() => {
      if (generation === this.generation) this.loading.delete(start);
      this.schedule(); this.scheduleAutoStats();
    });
  }

  private pageAt(index: number): Page | undefined {
    for (const page of this.pages.values()) if (index >= page.start && index < page.start + page.rows.length) return page;
    return undefined;
  }

  private removePage(start: number): void {
    this.cachedBytes -= this.pageBytes.get(start) ?? 0;
    this.pageBytes.delete(start);
    this.pages.delete(start); this.pageCellBytes.delete(start);
  }

  private invalidate(): void {
    clearTimeout(this.pendingLink); this.pendingLink = undefined;
    this.generation++;
    this.rowDrag?.cancel();
    this.clipboardMarker = undefined;
    this.resetRowMeasurements();
    this.pages.clear();
    this.pageBytes.clear(); this.pageCellBytes.clear();
    this.cachedBytes = 0;
    this.loading.clear();
    this.failed.clear();
    this.statsKey = ''; this.autoStatsKey = ''; this.updateSelectionStats();
  }

  private async setQuery(query: Query): Promise<boolean> {
    this.rowDrag.cancel();
    if (!this.metadata?.complete || this.operation) return false;
    this.operation = 'Preparing view…';
    this.renderStatus();
    try {
      if (!(await this.request({ type: 'confirmQuery', query }))) return false;
    } catch (error) { this.showError(error); return false; }
    finally { this.operation = ''; this.renderStatus(); }
    this.operation = 'Scanning all rows…';
    this.renderStatus();
    try {
      const result = await this.request({ type: 'query', query }) as RowPinsResult;
      this.query = query; this.rowLayout.clear();
      this.total = result.total;
      if (result.rows) this.rowPins = result.rows;
      if (result.visibleRows) this.visibleRowPins = result.visibleRows;
      this.error = '';
      this.invalidate();
      this.viewport.scrollTop = 0;
      this.clearSelection();
      this.closeMenu();
      this.render();
      return true;
    } catch (error) { this.showError(error); return false; }
    finally { this.operation = ''; this.renderStatus(); }
  }

  private togglePin(columns: number[]): void {
    const unpin = columns.every(col => this.frozen.has(col));
    for (const col of columns) { if (unpin) this.frozen.delete(col); else this.frozen.add(col); }
    this.clearSelection(); this.persist(); this.closeMenu(); this.render();
  }

  private async toggleRowPin(row: number): Promise<void> {
    if (!this.metadata?.complete || this.operation || this.clipboard.busy) return;
    if (!(await this.inlineEditor.commit(false))) return;
    const rows = this.rowPins.includes(row) ? this.rowPins.filter(source => source !== row) : [...this.rowPins, row];
    this.rowDrag.cancel(); this.operation = 'Preparing view…'; this.renderStatus();
    try {
      const result = await this.request({ type: 'pinRows', rows }) as RowPinsResult;
      this.rowPins = result.rows; this.visibleRowPins = result.visibleRows; this.total = result.total;
      this.pinnedScrollTop = 0; this.rowLayout.clear(); this.clearSelection(); this.invalidate(); this.closeMenu();
      this.viewport.scrollTop = 0; this.error = ''; this.render();
    } catch (error) { this.showError(error); }
    finally { this.operation = ''; this.render(); }
  }

  private toggleColumnMenu(kind: 'filter' | 'sort', col: number, anchor: HTMLElement): void {
    if (this.menu?.dataset.kind === kind && this.menu.dataset.column === String(col)) this.closeMenu();
    else if (kind === 'sort') this.openSortMenu(col, anchor);
    else this.openMenu(col, anchor);
  }

  private openSortMenu(col: number, anchor: HTMLElement, point?: { x: number; y: number }): void {
    if (!this.metadata?.complete || this.operation) return;
    this.closeMenu();
    const menu = document.createElement('div'); menu.className = 'column-menu';
    menu.dataset.kind = 'sort'; menu.dataset.column = String(col);
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', t('Sort options'));
    const directions = document.createElement('div'); directions.className = 'menu-section sort-choices';
    directions.setAttribute('role', 'group'); directions.setAttribute('aria-label', t('Sort direction'));
    const directionTitle = document.createElement('strong'); directionTitle.textContent = t('Sort direction'); directions.append(directionTitle);
    const current = this.query.sort?.col === col ? this.query.sort.direction : 0;
    for (const [label, direction] of [['Original order', 0], ['Ascending', 1], ['Descending', -1]] as const) {
      const button = this.button(label, label, () => {
        const sort = direction ? { col, direction, numeric: this.state.sortTypes?.[col] ?? 'auto' as const } : null;
        void this.setQuery({ ...this.query, sort });
      });
      button.setAttribute('aria-pressed', String(current === direction)); directions.append(button);
    }
    const types = document.createElement('div'); types.className = 'menu-section sort-choices';
    types.setAttribute('role', 'group'); types.setAttribute('aria-label', t('Sort type'));
    const typeTitle = document.createElement('strong'); typeTitle.textContent = t('Sort type'); types.append(typeTitle);
    for (const [label, numeric] of [['Auto', 'auto'], ['Number', true], ['Text', false]] as const) {
      const button = this.button(label, label, () => {
        const update = async () => {
          if (this.operation) return;
          if (this.query.sort?.col === col && !(await this.setQuery({ ...this.query, sort: { ...this.query.sort, numeric } }))) return;
          this.state.sortTypes = { ...this.state.sortTypes, [col]: numeric }; this.persist();
          for (const choice of types.querySelectorAll('button')) choice.setAttribute('aria-pressed', String(choice === button));
        };
        void update();
      });
      button.setAttribute('aria-pressed', String((this.state.sortTypes?.[col] ?? 'auto') === numeric)); types.append(button);
    }
    menu.append(directions, types);
    this.showColumnMenu(menu, col, anchor, directions.querySelector('button')!, point);
  }

  private openMenu(col: number, anchor: HTMLElement, point?: { x: number; y: number }): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.dataset.kind = point ? 'columns' : 'filter'; menu.dataset.column = String(col);
    menu.className = 'column-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', t(point ? 'Column options' : 'Column filter'));
    const activeFilter = this.query.filters.find(item => item.col === col);
    const select = (label: string, items: [string, string][], value: string): HTMLSelectElement => {
      const input = document.createElement('select'); input.setAttribute('aria-label', t(label));
      for (const [key, text] of items) { const option = document.createElement('option'); option.value = key; option.textContent = t(text); input.append(option); }
      input.value = value; return input;
    };
    if (point) {
      const pinning = document.createElement('div'); pinning.className = 'menu-section';
      const selected = this.selection.snapshot(this.total, this.visualColumns.length);
      const targets = selected && !selected.cells && selected.rowCount === this.total && selected.columns.includes(this.visualColumns.indexOf(col)) ? selected.columns.map(index => this.visualColumns[index]!) : [col];
      const pinned = targets.every(column => this.frozen.has(column));
      const label = targets.length === 1 ? (pinned ? 'Unpin column' : 'Pin to left') : t(pinned ? 'Unpin {count} selected columns' : 'Pin {count} selected columns to left', { count: targets.length });
      const pin = this.button(label, label, () => this.togglePin(targets));
      pinning.append(pin); menu.append(pinning);
      const structure = document.createElement('div'); structure.className = 'menu-section';
      const insertBefore = this.button('Insert column before…', 'Insert column before…', () => void this.performTool(() => this.dataTools.insertColumn(col)));
      const insertAfter = this.button('Insert column after…', 'Insert column after…', () => void this.performTool(() => this.dataTools.insertColumn(col + 1)));
      const remove = this.button('Delete selected columns…', 'Delete selected columns…', () => void this.performTool(() => {
        if (targets.length === 1) { this.selected = undefined; this.selection.startAxis('columns', this.visualColumns.indexOf(col), false); this.paintSelection(); }
        this.dataTools.deleteColumns(targets);
      }));
      for (const button of [insertBefore, insertAfter, remove]) button.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
      structure.append(insertBefore, insertAfter, remove); menu.append(structure);
      this.showColumnMenu(menu, col, anchor, pin, point);
      return;
    }
    const filterType = select('Filter type', [['text', 'Text'], ['regex', 'Regular expression'], ['values', 'Values'], ['number', 'Number'], ['empty', 'Empty'], ['notEmpty', 'Not empty']], activeFilter?.type ?? 'text');
    const filterLabel = document.createElement('label'); filterLabel.className = 'menu-field'; filterLabel.append(t('Filter'), filterType);
    const operator = select('Number comparison', [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'Between']], activeFilter?.type === 'number' ? activeFilter.operator : 'eq');
    const filter = document.createElement('input'); filter.placeholder = t('Contains…'); filter.setAttribute('aria-label', t('Filter column by text'));
    filter.value = activeFilter && (!activeFilter.type || activeFilter.type === 'text' || activeFilter.type === 'regex') ? activeFilter.text : '';
    const number = document.createElement('input'); number.type = 'number'; number.step = 'any'; number.placeholder = t('Value'); number.setAttribute('aria-label', t('Filter number'));
    const maximum = document.createElement('input'); maximum.type = 'number'; maximum.step = 'any'; maximum.placeholder = t('Maximum'); maximum.setAttribute('aria-label', t('Filter maximum'));
    if (activeFilter?.type === 'number') { number.value = String(activeFilter.value); maximum.value = activeFilter.max === undefined ? '' : String(activeFilter.max); }
    const filterError = document.createElement('div'); filterError.className = 'filter-error'; filterError.setAttribute('role', 'alert');
    const valuesBox = document.createElement('div'); valuesBox.className = 'filter-values'; valuesBox.hidden = true;
    const valueSearch = document.createElement('input'); valueSearch.placeholder = t('Search values…'); valueSearch.setAttribute('aria-label', t('Search values'));
    const valueActions = document.createElement('div'); valueActions.className = 'menu-actions';
    const valueList = document.createElement('div'); valueList.className = 'filter-value-list';
    const valueStatus = document.createElement('small'); valueStatus.setAttribute('role', 'status');
    let choices: DistinctResult['values'] | undefined;
    let selectedValues = activeFilter?.type === 'values' ? new Set(activeFilter.values) : undefined;
    let valueRequest = 0, loadingValues = false;
    let apply: HTMLButtonElement;
    const clampMenu = () => {
      if (menu.isConnected) menu.style.top = `${Math.max(4, Math.min(Number.parseFloat(menu.style.top) || 4, window.innerHeight - menu.offsetHeight - 4))}px`;
    };
    const drawValues = () => {
      const search = valueSearch.value.toLocaleLowerCase();
      valueList.replaceChildren();
      for (const choice of choices ?? []) {
        if (!choice.value.toLocaleLowerCase().includes(search)) continue;
        const label = document.createElement('label'); label.dataset.tooltip = t('Click: include or exclude this value');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedValues?.has(choice.value) ?? false;
        const text = document.createElement('span'); text.textContent = choice.value === '' ? t('(Empty)') : choice.value.slice(0, 160).replace(/\r?\n/g, ' ↵ ');
        const count = document.createElement('small'); count.textContent = choice.count.toLocaleString();
        checkbox.setAttribute('aria-label', choice.value === '' ? t('(Empty)') : choice.value);
        checkbox.onchange = () => { if (checkbox.checked) selectedValues?.add(choice.value); else selectedValues?.delete(choice.value); };
        label.append(checkbox, text, count); valueList.append(label);
      }
      clampMenu();
    };
    valueSearch.oninput = drawValues;
    valueActions.append(this.button('Select all', 'Select all values', () => { selectedValues = new Set(choices?.map(choice => choice.value)); drawValues(); }),
      this.button('Clear', 'Clear selected values', () => { selectedValues?.clear(); drawValues(); }));
    valuesBox.append(valueSearch, valueActions, valueStatus, valueList);
    const loadValues = async () => {
      const request = ++valueRequest, generation = this.generation;
      loadingValues = true; apply.disabled = true; valueStatus.textContent = t('Loading values…');
      try {
        const result = await this.request({ type: 'distinct', col }) as DistinctResult;
        if (request !== valueRequest || generation !== this.generation || this.menu !== menu || filterType.value !== 'values') return;
        choices = result.values;
        selectedValues ??= new Set(choices.map(choice => choice.value));
        valueStatus.textContent = t('{count} unique values', { count: result.total.toLocaleString() }); drawValues();
      } catch (error) {
        if (request !== valueRequest || generation !== this.generation || this.menu !== menu || filterType.value !== 'values') return;
        valueStatus.textContent = '';
        filterError.textContent = `${t(error instanceof Error ? error.message : String(error))} ${t('Use Text or Regular expression to filter this column.')}`;
      } finally {
        if (request === valueRequest && this.menu === menu && filterType.value === 'values') { loadingValues = false; apply.disabled = !choices || !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus); }
      }
    };
    const updateInputs = () => {
      const text = filterType.value === 'text' || filterType.value === 'regex';
      filter.hidden = !text; operator.hidden = number.hidden = filterType.value !== 'number';
      maximum.hidden = filterType.value !== 'number' || operator.value !== 'between'; filterError.textContent = '';
      filter.placeholder = t(filterType.value === 'regex' ? 'Pattern…' : 'Contains…');
      filter.setAttribute('aria-label', t(filterType.value === 'regex' ? 'Filter column by regular expression' : 'Filter column by text'));
      valuesBox.hidden = filterType.value !== 'values';
      if (filterType.value !== 'values') { valueRequest++; loadingValues = false; apply.disabled = false; }
      else if (!choices) { void loadValues(); }
      else { apply.disabled = false; drawValues(); }
      if (!this.metadata?.complete || this.operation || this.clipboardStatus) apply.disabled = true;
      clampMenu();
    };
    filterType.addEventListener('change', updateInputs); operator.addEventListener('change', updateInputs);
    apply = this.button('Apply', 'Apply filter', () => {
      const filters = this.query.filters.filter(item => item.col !== col);
      const kind = filterType.value;
      if (kind === 'values') {
        if (loadingValues || !choices || !selectedValues?.size) { filterError.textContent = t('Select at least one value.'); return; }
        filters.push({ col, type: 'values', values: [...selectedValues] });
      } else if (kind === 'number') {
        if (!number.value || !number.validity.valid || !Number.isFinite(number.valueAsNumber)) { filterError.textContent = t('Enter a valid number.'); number.focus(); return; }
        if (operator.value === 'between' && (!maximum.value || !maximum.validity.valid || !Number.isFinite(maximum.valueAsNumber) || maximum.valueAsNumber < number.valueAsNumber)) {
          filterError.textContent = t('Maximum must be at least the minimum.'); maximum.focus(); return;
        }
        filters.push({ col, type: 'number', operator: operator.value as Extract<Filter, { type: 'number' }>['operator'], value: number.valueAsNumber,
          ...(operator.value === 'between' ? { max: maximum.valueAsNumber } : {}) });
      } else if (kind === 'empty' || kind === 'notEmpty') filters.push({ col, type: kind });
      else if (filter.value) filters.push({ col, type: kind === 'regex' ? 'regex' : 'text', text: filter.value });
      void this.setQuery({ ...this.query, filters }).then(applied => { if (!applied && this.menu === menu) filterError.textContent = t(this.error || 'Filter was not applied.'); });
    });
    for (const input of [filter, number, maximum]) input.addEventListener('keydown', event => { if (event.key === 'Enter') apply.click(); });
    const filterActions = document.createElement('div'); filterActions.className = 'menu-actions';
    filterActions.append(this.button('Reset', 'Reset column filter', () => void this.setQuery({ ...this.query, filters: this.query.filters.filter(item => item.col !== col) })), apply);
    const filtering = document.createElement('div'); filtering.className = 'menu-section'; filtering.setAttribute('role', 'group'); filtering.setAttribute('aria-label', t('Filtering'));
    filtering.append(filterLabel, operator, filter, number, maximum, valuesBox, filterError, filterActions);
    menu.append(filtering);
    for (const control of menu.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) control.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
    if (!this.metadata?.complete) {
      const note = document.createElement('small'); note.textContent = t('Available after indexing'); filtering.append(note);
    }
    this.showColumnMenu(menu, col, anchor, filterType);
    updateInputs();
  }

  private showColumnMenu(menu: HTMLElement, col: number, anchor: HTMLElement, focus: HTMLElement, point?: { x: number; y: number }): void {
    const rect = anchor.getBoundingClientRect();
    this.root.append(menu);
    menu.style.left = `${Math.max(4, Math.min(point?.x ?? rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(point?.y ?? rect.bottom + 4, window.innerHeight - menu.offsetHeight - 4))}px`;
    this.menu = menu;
    menu.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); this.closeMenu();
      const target = anchor.isConnected ? anchor : this.heading.querySelector<HTMLElement>(`.column-heading[data-col='${col}']`);
      target?.focus({ preventScroll: true });
    });
    if (!this.guide.open) focus.focus();
  }

  private guideSteps(): GuideStep[] {
    this.guideReturnText = this.textEditor.visible;
    this.fileMenu.close(); this.viewMenu.close();
    const tips: GuideStep = {
      title: 'Tips while you work',
      text: 'Hover over a cell, header, or button to see blue Tips beside the top menus. They explain available actions, including clicking, double-clicking, dragging, and right-clicking.',
      target: () => this.root.querySelector('.toolbar-hint'),
      enter: () => {
        this.root.classList.add('guide-tips');
        this.tooltips.preview(this.canvas.querySelector<HTMLElement>('.cell[data-col]') ?? this.textButton);
      },
      leave: () => { this.root.classList.remove('guide-tips'); this.tooltips.preview(); },
    };
    const colors: GuideStep = { title: 'What the colors mean', text: 'Pale red marks edited values and newly inserted cells. Orange marks sorting and filtering, which change only the view. Try this sample without changing your file.', target: () => this.textButton, preview: () => this.colorExample() };
    const save = { title: 'Save and recover', text: 'Save writes your content changes. Save as creates another file. Export saves filtered rows and visible columns in their current sort order. Recover restores a previous version.', enter: () => this.fileMenu.show(), target: () => this.fileMenu.panel, leave: () => this.fileMenu.close() };
    const heading = () => this.heading.querySelector<HTMLElement>('.column-heading[data-col]');
    const textStep: GuideStep = {
      title: 'Block editing in Text',
      text: 'Align lines up columns; Fold multiline keeps each record on one line. Hold Option (⌥) on Mac or Alt on Windows/Linux and drag across lines for multiple cursors. Type or delete together; Escape returns to one cursor. The tour does not change your CSV.',
      enter: async () => {
        this.setTextMode(true);
        this.renderStatus(); await this.textEditor.preview();
      },
      target: () => this.root.querySelector('.cm-line') ?? this.root.querySelector('.text-error:not([hidden])') ?? this.textButton,
      leave: () => {
        this.setTextMode(false);
        this.render();
      },
    };
    const menuStep = (options: boolean): GuideStep => ({
      title: options ? 'Pin and arrange columns' : 'Find your data',
      text: options ? 'Right-click a header for Pin. Double-click a Drag handle to pin or unpin a column on the left or a row at the top. Dragging changes the saved column or row order.' : 'Click the funnel to open filters. Click Sort to choose the direction and Auto, Number or Text sorting. Double-click Sort to cycle ascending, descending and original order.',
      enter: () => {
        const column = heading(), anchor = column?.querySelector<HTMLElement>('.column-filter-button');
        if (!column || !anchor) return;
        anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        const rect = anchor.getBoundingClientRect();
        this.openMenu(Number(column.dataset.col), anchor, options ? { x: rect.left, y: rect.bottom } : undefined);
      },
      target: () => this.menu ?? heading() ?? this.viewport,
      leave: () => this.closeMenu(),
    });
    return [
      { title: 'Browse and edit', text: 'Drag across cells to select a range. Double-click a cell to edit or select and copy part of its text.', enter: () => this.setTextMode(false), target: () => this.canvas.querySelector('.cell[data-col]') ?? this.heading },
      menuStep(false), menuStep(true),
      textStep, save, tips, colors,
    ];
  }

  private colorExample(): HTMLElement {
    const example = document.createElement('div'); example.className = 'guide-color-example';
    const table = document.createElement('table'); table.setAttribute('aria-label', t('Color example'));
    const header = table.createTHead().insertRow();
    const product = document.createElement('th'); product.textContent = t('Product');
    const amount = document.createElement('th'); amount.className = 'column-heading'; amount.textContent = t('Quantity');
    const sort = this.iconButton('ascending', t('Sort example'), () => {}); sort.classList.add('column-sort-button');
    const filter = this.iconButton('filter', t('Filter example'), () => {}); filter.classList.add('column-filter-button');
    sort.disabled = filter.disabled = true; amount.append(sort, filter); header.append(product, amount);
    const body = table.createTBody();
    const draw = (run: boolean) => {
      body.replaceChildren(); amount.classList.toggle('filtered', run); sort.classList.toggle('active', run);
      for (const [name, quantity, edited] of run ? [['Pencil', '20', false], ['Notebook', '30', true]] as const : [['Notebook', '10', false], ['Pencil', '20', false], ['Eraser', '5', false]] as const) {
        const row = body.insertRow(); row.insertCell().textContent = name;
        const value = row.insertCell(); value.textContent = quantity; value.className = edited ? 'cell modified' : 'cell';
      }
    };
    const run = this.button('Run example', 'Run example', () => draw(true));
    const reset = this.button('Reset', 'Reset', () => draw(false));
    const actions = document.createElement('div'); actions.append(reset, run);
    example.append(table, actions); draw(false); return example;
  }

  private closeMenu(): void { this.menu?.remove(); this.menu = undefined; }

  private async fullCell(cell: Cell): Promise<Cell> {
    const page = await this.request({ type: 'page', start: cell.index, count: 1 }) as Page;
    const row = page.rows[0];
    if (!row || row.id !== cell.row) throw new Error('The view changed. Select the cell again.');
    return { ...cell, value: row.values[cell.col] ?? '' };
  }

  private async openCell(selected: Cell): Promise<void> {
    if (this.operation || this.fileDialogs.open || this.guide.open || this.clipboard.busy) return;
    if (!(await this.inlineEditor.commit(false))) return;
    this.operation = 'Opening cell…'; this.renderStatus();
    let cell: Cell;
    try { cell = await this.fullCell(selected); }
    catch (error) { this.showError(error); return; }
    finally { this.operation = ''; this.renderStatus(); }
    this.selected = cell;
    window.getSelection()?.removeAllRanges(); this.closeMenu();
    this.inlineEditor.show({
      value: cell.value,
      label: `${this.metadata?.headers[cell.col] || t('Column {number}', { number: cell.col + 1 })} #${cell.row + 1}`,
      anchor: () => this.canvas.querySelector<HTMLElement>(`[data-row="${cell.row}"][data-col="${cell.col}"]`)?.getBoundingClientRect() ?? null,
      commit: async value => {
        if (value === cell.value) return;
        await this.request({ type: 'edit', edit: { row: cell.row, col: cell.col, value } });
        this.error = ''; this.selected = { ...cell, value: value.slice(0, 4096) };
        this.dataTools.invalidateChecks(); this.invalidate(); this.render();
      },
    });
  }

  private async openHeader(col: number): Promise<void> {
    if (!this.metadata?.hasHeader || !this.metadata.complete || this.operation || this.fileDialogs.open || this.promptDialog.open || this.guide.open || this.clipboard.busy) return;
    if (!(await this.inlineEditor.commit(false))) return;
    const value = this.metadata.headers[col] ?? '';
    this.closeMenu(); window.getSelection()?.removeAllRanges();
    this.inlineEditor.show({
      value, label: t('column header'),
      anchor: () => this.heading.querySelector<HTMLElement>(`[data-col="${col}"]`)?.getBoundingClientRect() ?? null,
      commit: async name => {
        const result = await this.request({ type: 'change', operation: { kind: 'renameColumn', col, name } }) as ChangeResult;
        this.receiveMetadata(result.metadata); this.error = ''; this.render();
      },
    });
  }

  private selectAllCells(): void {
    this.selected = undefined; this.selection.selectAll(); window.getSelection()?.removeAllRanges();
    this.viewport.focus({ preventScroll: true }); this.paintSelection();
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.clipboardMarker) { event.preventDefault(); this.clipboardMarker = undefined; this.paintSelection(); return; }
    if (event.key === 'Enter' && this.selected) { event.preventDefault(); this.openCell(this.selected); return; }
    if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v'].includes(event.key.toLowerCase())) {
      if (!this.selectionRequest()) return;
      event.preventDefault();
      const action = event.key.toLowerCase() === 'c' ? 'copy' : event.key.toLowerCase() === 'x' ? 'cut' : 'paste';
      void this.clipboardAction(action); return;
    }
    if (!this.selected || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const visual = this.visualColumns;
    const colIndex = visual.indexOf(this.selected.col);
    const col = visual[Math.max(0, Math.min(visual.length - 1, colIndex + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0)))]!;
    const index = Math.max(0, Math.min(this.total - 1, this.selected.index + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0)));
    const page = this.pageAt(index);
    const row = page?.rows[index - page.start];
    if (!row) { this.loadPage(index); return; }
    this.selected = { row: row.id, col, index, value: row.values[col] ?? '' };
    if (event.shiftKey) this.selection.extend(index, visual.indexOf(col));
    else this.selection.start(index, visual.indexOf(col));
    this.updateSelectionStats();
    const top = this.rowLayout.offset(index), bottom = top + this.rowLayout.height(index);
    const logicalTop = this.logicalScrollTop;
    if (index < this.visibleRowPins.length) {
      if (top < this.pinnedScrollTop) this.pinnedScrollTop = top;
      else if (bottom > this.pinnedScrollTop + this.pinnedViewportHeight) this.pinnedScrollTop = bottom - this.pinnedViewportHeight;
    } else if (top < logicalTop) this.scrollToLogical(top);
    else if (bottom > logicalTop + this.viewport.clientHeight - this.pinnedViewportHeight) this.scrollToLogical(bottom - this.viewport.clientHeight + this.pinnedViewportHeight);
    if (!this.frozen.has(col)) {
      const left = this.numberWidth + this.columnSpan(visual.slice(0, visual.indexOf(col)));
      const pinnedWidth = this.numberWidth + this.columnSpan(visual.filter(column => this.frozen.has(column)));
      if (left - this.viewport.scrollLeft < pinnedWidth) this.viewport.scrollLeft = left - pinnedWidth;
      if (left + this.width(col) > this.viewport.scrollLeft + this.viewport.clientWidth) this.viewport.scrollLeft = left + this.width(col) - this.viewport.clientWidth;
    }
    this.render();
  }

  private setTextMode(visible: boolean): void {
    clearTimeout(this.pendingLink); this.pendingLink = undefined;
    this.root.classList.toggle('text-mode', visible); this.heading.hidden = visible; this.viewport.hidden = visible;
    this.textEditor.element.hidden = !visible; this.textEditor.alignControl.hidden = !visible; this.textEditor.collapseControl.hidden = !visible;
    this.setIcon(this.textButton, visible ? 'table' : 'text'); this.textButton.dataset.tooltip = t(visible ? 'Click: switch to Table mode' : 'Click: switch to Text mode');
    this.textButton.setAttribute('aria-label', t(visible ? 'Switch to Table mode' : 'Switch to Text mode'));
    const mode = visible ? 'Switch to Table mode' : 'Switch to Text mode';
    this.modeMenuItem.textContent = t(mode); this.modeMenuItem.dataset.l10nText = mode;
    this.modeMenuItem.dataset.l10nTooltip = mode; this.modeMenuItem.dataset.l10nLabel = mode;
    this.modeMenuItem.setAttribute('aria-label', t(mode)); this.modeMenuItem.dataset.tooltip = t('Click: {action}', { action: t(mode) });
  }

  private toggleTheme(): void {
    this.state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    this.persist(); this.applyTheme();
  }

  private showGuide(): void {
    if (!this.inlineEditor.open && !this.fileDialogs.open && !this.dataTools.open && !this.operation) {
      this.closeMenu(); this.viewMenu.close(); this.guide.show();
    }
  }

  private async toggleText(start?: number): Promise<void> {
    this.rowDrag.cancel();
    if (!(await this.inlineEditor.commit(false))) return;
    if (this.operation || this.fileDialogs.open || this.dataTools.open || this.guide.open) return;
    this.closeMenu();
    if (this.textEditor.visible && start === undefined) {
      if (!(await this.textEditor.hide())) return;
      this.setTextMode(false);
      this.invalidate(); this.render();
    } else {
      this.clearSelection(); this.setTextMode(true);
      await this.textEditor.open(start ?? 0);
    }
    this.renderStatus();
  }

  private async history(type: 'undo' | 'redo'): Promise<void> {
    if (!(await this.inlineEditor.commit(false))) return;
    if (this.textEditor.visible) await this.textEditor.flush();
    if (this.operation || !(type === 'undo' ? this.canUndo : this.canRedo)) return;
    if (!(await this.run({ type }))) return;
    this.invalidate(); this.clearSelection(); this.render();
  }

  private async save(type: 'save' | 'saveAs' = 'save'): Promise<void> {
    if (!this.metadata?.complete || this.operation || this.fileDialogs.open) return;
    if (!(await this.inlineEditor.commit(false))) return;
    if (this.textEditor.visible && !(await this.textEditor.flush())) return;
    this.operation = 'Saving…'; this.renderStatus();
    if (await this.run({ type })) { this.invalidate(); this.render(); }
    this.operation = ''; this.renderStatus();
  }

  private async exportView(): Promise<void> {
    if (!this.metadata?.complete || this.operation || this.fileDialogs.open) return;
    if (!(await this.inlineEditor.commit(false))) return;
    if (this.textEditor.visible && !(await this.textEditor.flush())) return;
    const hidden = new Set(this.state.hidden ?? []);
    const columns = this.metadata.headers.map((_, col) => col).filter(col => !hidden.has(col));
    this.operation = 'Exporting…'; this.renderStatus();
    try { await this.run({ type: 'export', columns }); }
    finally { this.operation = ''; this.renderStatus(); }
  }

  private async recover(): Promise<void> {
    if (!(await this.inlineEditor.commit(false))) return;
    if (this.operation || this.fileDialogs.open || this.guide.open) return;
    this.operation = 'Loading versions…'; this.renderStatus();
    try {
      const load = (scope: 'file' | 'all') => this.request({ type: 'versions', scope }) as Promise<VersionList>;
      const versions = await load('file');
      this.operation = ''; this.renderStatus();
      const choice = await this.fileDialogs.recover(versions, load, async scope => { await this.request({ type: 'clearVersions', scope }); });
      if (choice) { this.operation = 'Recovering…'; this.renderStatus(); await this.request({ type: 'recover', ...choice }); this.error = ''; }
    } catch (error) { this.showError(error); }
    finally { this.operation = ''; this.renderStatus(); }
  }

  private async run(request: Request): Promise<boolean> {
    try { await this.request(request); this.error = ''; this.renderStatus(); return true; }
    catch (error) { this.showError(error); return false; }
  }

  private showError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.renderStatus();
  }

  private updateSelectionStats(): void {
    const selected = this.selection.snapshot(this.total, this.visualColumns.length);
    const columns = selected ? selected.columns.map(index => this.visualColumns[index]!) : [];
    const key = selected ? `${this.generation}:${JSON.stringify(selected.ranges)}:${columns.join(',')}:${JSON.stringify(selected.cells)}` : '';
    if (key !== this.statsKey) {
      this.statsKey = key; this.autoStatsKey = ''; this.statsVersion++; this.stats = undefined; this.statsError = ''; this.statsLoading = false;
    }
    this.renderStatus(); this.scheduleAutoStats();
  }

  private canAutoCalculate(): boolean {
    const selection = this.selectionRequest(); if (!selection) return false;
    const ranges = selection.ranges ?? [{ start: selection.start, count: selection.count }];
    if ((selection.cells?.length ?? ranges.reduce((sum, range) => sum + range.count, 0) * selection.columns.length) > 1000) return false;
    let bytes = 0;
    const cached = (index: number, col: number): boolean => {
      const page = this.pageAt(index), row = page?.rows[index - page.start]; if (!row) return false;
      bytes += this.pageCellBytes.get(page!.start)?.[index - page!.start]?.[col] ?? 0;
      return bytes <= 256 * 1024;
    };
    if (selection.cells) { for (const cell of selection.cells) if (!cached(cell.row, cell.col)) return false; }
    else for (const range of ranges) for (let index = range.start; index < range.start + range.count; index++) for (const col of selection.columns) if (!cached(index, col)) return false;
    return true;
  }

  private scheduleAutoStats(): void {
    clearTimeout(this.statsTimer);
    if (this.selecting || this.stats || this.statsError || this.statsInFlight || this.autoStatsKey === this.statsKey || this.operation || !this.canAutoCalculate()) return;
    const key = this.statsKey;
    this.statsTimer = setTimeout(() => { if (key === this.statsKey && !this.selecting) { this.autoStatsKey = key; void this.calculateSelection(); } }, 200);
  }

  private async calculateSelection(): Promise<void> {
    const selected = this.selection.snapshot(this.total, this.visualColumns.length);
    if (!selected || this.selecting || this.statsInFlight) return;
    const columns = selected.columns.map(index => this.visualColumns[index]!);
    const version = this.statsVersion;
    this.statsInFlight = true; this.statsLoading = true; this.stats = undefined; this.statsError = ''; this.renderStatus();
    const start = selected.ranges[0]!.start, last = selected.ranges.at(-1)!;
    try {
      const result = await this.request({ type: 'stats', start, count: last.start + last.count - start, columns, ranges: selected.ranges, ...(selected.cells ? { cells: selected.cells.map(cell => ({ row: cell.row, col: this.visualColumns[cell.col]! })) } : {}) });
      if (version === this.statsVersion) this.stats = result as SelectionStats;
    } catch (error) {
      if (version === this.statsVersion) this.statsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.statsInFlight = false;
      if (version === this.statsVersion) this.statsLoading = false;
      this.renderStatus(); this.scheduleAutoStats();
    }
  }

  private renderStatus(): void {
    const scan = this.metadata && !this.metadata.complete ? t('Indexing {percent}%', { percent: Math.min(100, Math.floor(this.metadata.scanned / Math.max(1, this.metadata.bytes) * 100)) }) : '';
    const rows = this.query.filters.length ? t('Filtered rows: {count}', { count: this.total.toLocaleString() }) : '';
    const selection = this.selection.snapshot(this.total, this.visualColumns.length);
    const format = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 15 });
    const selected = selection ? selection.cells ? t('{rows} rows · {columns} columns · {cells} cells', { rows: selection.rowCount, columns: selection.columnCount, cells: selection.cells.length }) : t('{rows} rows × {columns} columns', { rows: selection.rowCount, columns: selection.columnCount }) : '';
    const summary = this.stats ? ' · ' + t('Sum {sum} · AVG {average} · Min {min} · Max {max} · Numbers {numbers} · Non-empty {nonEmpty}', { sum: format(this.stats.sum), average: this.stats.average === null ? '—' : format(this.stats.average), min: this.stats.min === null ? '—' : format(this.stats.min), max: this.stats.max === null ? '—' : format(this.stats.max), numbers: format(this.stats.numericCount), nonEmpty: format(this.stats.nonEmptyCount) })
      : this.statsError ? ' · ' + t('Statistics unavailable') : this.statsLoading ? ' · ' + t('Calculating…') : '';
    this.status.replaceChildren();
    if (selection) {
      const selectionText = document.createElement('span');
      selectionText.className = 'selection-summary';
      selectionText.textContent = `${selected}${summary}`;
      const calculate = this.button('Calculate', 'Calculate selection', () => void this.calculateSelection());
      calculate.disabled = this.statsInFlight || Boolean(this.operation || this.clipboardStatus);
      this.status.append(selectionText);
      if (!this.canAutoCalculate() || this.statsError) this.status.append(calculate);
    }
    const text = document.createElement('span'); text.className = 'status-text';
    text.textContent = this.error ? t(this.error) : [rows, this.changes ? t('{count} changed', { count: this.changes.toLocaleString() }) : '', scan, t(this.clipboardStatus || this.operation)].filter(Boolean).join(' · ');
    this.status.append(text);
    this.status.classList.toggle('error', Boolean(this.error));

    if (this.failed.size) this.status.append(this.button('Retry', 'Retry loading visible rows', () => {
      this.failed.clear(); this.error = ''; this.render();
    }));
    const total = document.createElement('span'); total.className = 'status-total';
    total.textContent = this.metadata ? t('Total rows: {count}', { count: this.metadata.rows.toLocaleString() }) : t('Opening…');
    this.status.append(total);
    this.headerButton.setAttribute('aria-pressed', String(this.metadata?.hasHeader ?? true));
    const textVisible = this.textEditor?.visible ?? false;
    this.calculateMenuItem.disabled = textVisible || !selection || this.selecting || this.statsInFlight || Boolean(this.operation || this.clipboardStatus);
    for (const button of this.viewMenu.panel.querySelectorAll<HTMLButtonElement>('button')) {
      if ([this.modeMenuItem, this.themeMenuItem, this.guideMenuItem].includes(button)) {
        button.disabled = Boolean(this.operation || this.clipboardStatus) || !this.metadata; continue;
      }
      button.disabled = ([this.alignMenuItem, this.collapseMenuItem].includes(button) ? !textVisible : textVisible) || !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
    }
    this.collapseMenuItem.setAttribute('aria-pressed', String(this.state.collapseText ?? true));
    this.alignMenuItem.setAttribute('aria-pressed', String(this.state.alignText ?? true));
    this.saveButton.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
    for (const button of [this.undoButton, this.undoMenuItem]) button.disabled = !this.canUndo || Boolean(this.operation || this.clipboardStatus);
    for (const button of [this.redoButton, this.redoMenuItem]) button.disabled = !this.canRedo || Boolean(this.operation || this.clipboardStatus);
    this.textButton.disabled = Boolean(this.operation || this.clipboardStatus) || !this.metadata;
    for (const button of this.heading.querySelectorAll<HTMLButtonElement>('.column-sort-button, .column-filter-button')) button.disabled = !this.metadata?.complete || Boolean(this.operation || this.clipboardStatus);
  }
}
