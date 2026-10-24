/*
Keep data-check results available beside the table, with navigation and checked cell selection.
*/
import { locale, t } from '../Locale';
import type { CheckOptions, CheckResult, Metadata } from '../protocol';

type CheckKind = 'duplicates' | 'missing' | 'ragged';
type Context = {
  metadata: () => Metadata | undefined;
  prepare: () => Promise<void>;
  check: (kind: CheckKind, columns?: number[], after?: CheckOptions['after']) => Promise<CheckResult>;
  locate: (row: number, col?: number) => Promise<void>;
  selectIssues: (issues: CheckResult['issues']) => Promise<void>;
};

export class CheckPanel {
  readonly element = document.createElement('section');
  private readonly title = document.createElement('strong');
  private readonly kind = document.createElement('select');
  private readonly column = document.createElement('select');
  private readonly kindLabel = document.createElement('span');
  private readonly columnLabel = document.createElement('span');
  private readonly run = document.createElement('button');
  private readonly close = document.createElement('button');
  private readonly summary = document.createElement('p');
  private readonly notice = document.createElement('p');
  private readonly list = document.createElement('div');
  private readonly all = document.createElement('input');
  private readonly allLabel = document.createElement('span');
  private readonly previous = document.createElement('button');
  private readonly next = document.createElement('button');
  private readonly position = document.createElement('span');
  private readonly selectCells = document.createElement('button');
  private readonly checked = new Set<number>();
  private result?: CheckResult;
  private current = -1;
  private stale = false;
  private busy = false;
  private revision = 0;
  private error = '';
  private optionChange = false;
  private page = 0;
  private readonly starts: { after?: CheckOptions['after']; offset: number }[] = [{ offset: 0 }];
  private readonly pages = new Map<number, CheckResult>();

  constructor(root: HTMLElement, private readonly context: Context) {
    this.element.className = 'check-panel'; this.element.hidden = true;
    this.element.setAttribute('role', 'region');
    const header = document.createElement('header'); header.append(this.title, this.close);
    const controls = document.createElement('div'); controls.className = 'check-controls';
    const kindField = document.createElement('label'); kindField.append(this.kindLabel, this.kind);
    const columnField = document.createElement('label'); columnField.append(this.columnLabel, this.column);
    controls.append(kindField, columnField, this.run);
    this.summary.className = 'check-summary'; this.summary.setAttribute('role', 'status');
    this.notice.className = 'check-notice'; this.notice.setAttribute('role', 'alert');
    this.list.className = 'check-results';
    this.all.type = 'checkbox';
    const allField = document.createElement('label'); allField.className = 'check-all'; allField.append(this.all, this.allLabel);
    const footer = document.createElement('footer'); footer.append(allField, this.previous, this.position, this.next, this.selectCells);
    this.element.append(header, controls, this.summary, this.notice, this.list, footer);
    root.insertBefore(this.element, root.querySelector('.status'));
    this.close.onclick = () => { this.element.hidden = true; };
    this.run.onclick = () => { void this.runCheck(); };
    this.previous.onclick = () => { void this.navigate(-1); };
    this.next.onclick = () => { void this.navigate(1); };
    this.selectCells.onclick = () => { void this.selectCheckedCells(); };
    this.all.onchange = () => {
      this.checked.clear();
      if (this.all.checked) this.result?.issues.forEach((_, index) => this.checked.add(index));
      this.drawResults(); this.update(); void this.selectCheckedCells();
    };
    const change = () => { this.optionChange = true; this.markStale(); this.update(); };
    this.kind.onchange = change; this.column.onchange = change;
    locale.subscribe(() => { this.translate(); this.drawResults(); this.update(); });
    this.translate(); this.update();
  }

  show(): void {
    this.translate(); this.element.hidden = false; this.update(); this.kind.focus({ preventScroll: true });
  }

  markStale(): void {
    this.revision++;
    if (this.result) { this.stale = true; this.update(); }
  }

  private translate(): void {
    this.element.setAttribute('aria-label', t('Data check results'));
    this.title.textContent = t('Check entire file');
    this.kindLabel.textContent = t('Check'); this.kind.setAttribute('aria-label', t('Check'));
    this.columnLabel.textContent = t('Column'); this.column.setAttribute('aria-label', t('Column'));
    const previousKind = this.kind.value || 'duplicates', previousColumn = this.column.value || 'all';
    this.kind.replaceChildren(...(['duplicates', 'missing', 'ragged'] as const).map((value, index) => {
      const option = document.createElement('option'); option.value = value;
      option.textContent = t(['Duplicate values', 'Empty cells', 'Inconsistent column counts'][index]!); return option;
    }));
    this.kind.value = previousKind;
    const all = document.createElement('option'); all.value = 'all'; all.textContent = t('All columns');
    this.column.replaceChildren(all, ...(this.context.metadata()?.headers ?? []).map((name, index) => {
      const option = document.createElement('option'); option.value = String(index); option.textContent = name || t('Column {number}', { number: index + 1 }); return option;
    }));
    this.column.value = [...this.column.options].some(option => option.value === previousColumn) ? previousColumn : 'all';
    this.run.textContent = t('Run check'); this.close.textContent = t('Close');
    this.close.setAttribute('aria-label', t('Close check results'));
    this.previous.textContent = t('Previous'); this.next.textContent = t('Next');
    this.previous.dataset.tooltip = t('Click: go to the previous listed issue'); this.next.dataset.tooltip = t('Click: go to the next listed issue');
    this.allLabel.textContent = t('Select listed results'); this.all.setAttribute('aria-label', t('Select all listed results'));
    this.selectCells.textContent = t('Select checked cells');
    this.selectCells.dataset.tooltip = t('Click: select cells for checked results');
  }

  private update(): void {
    const count = this.result?.issues.length ?? 0;
    this.summary.textContent = this.result ? `${t('{count} issues', { count: this.result.total.toLocaleString() })} · ${t('Showing {first}–{last}', { first: count ? this.starts[this.page]!.offset + 1 : 0, last: this.starts[this.page]!.offset + count })} · ${t('{count} checked', { count: this.checked.size })}` : '';
    this.notice.textContent = this.stale ? t(this.optionChange ? 'Check options changed. Run check again before navigating or selecting cells.' : 'Data changed. Run check again before navigating or selecting cells.') : t(this.error);
    if (this.stale && this.error) this.notice.textContent += ` ${t(this.error)}`;
    this.notice.hidden = !this.notice.textContent;
    this.element.classList.toggle('stale', this.stale);
    this.run.disabled = this.busy; this.run.setAttribute('aria-busy', String(this.busy));
    this.kind.disabled = this.busy; this.column.disabled = this.busy || this.kind.value === 'ragged';
    this.previous.disabled = this.busy || this.stale || (this.current <= 0 && !this.page);
    this.next.disabled = this.busy || this.stale || !count || (this.current >= count - 1 && !this.result?.truncated);
    this.selectCells.disabled = this.busy || this.stale || !this.checked.size;
    this.all.disabled = this.busy || this.stale || !count; this.all.checked = Boolean(count && this.checked.size === count);
    this.all.indeterminate = this.checked.size > 0 && this.checked.size < count;
    this.position.textContent = count ? `${this.current < 0 ? 0 : this.starts[this.page]!.offset + this.current + 1} / ${this.result!.total}` : '';
    for (const row of this.list.children) {
      row.classList.toggle('current', Number((row as HTMLElement).dataset.issue) === this.current);
      const button = row.querySelector('button')!; button.disabled = this.busy || this.stale;
      button.setAttribute('aria-current', String(Number((row as HTMLElement).dataset.issue) === this.current));
      row.querySelector('input')!.disabled = this.busy || this.stale;
    }
  }

  private drawResults(): void {
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...(this.result?.issues ?? []).map((issue, index) => {
      const row = document.createElement('div'); row.dataset.issue = String(index);
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.checked.has(index);
      checkbox.setAttribute('aria-label', t('Select listed issue {number}', { number: index + 1 }));
      checkbox.onchange = () => { if (checkbox.checked) this.checked.add(index); else this.checked.delete(index); this.update(); void this.selectCheckedCells(); };
      const button = document.createElement('button');
      button.textContent = `${t('Row #{number}', { number: issue.row + 1 })}${issue.col !== undefined ? ` · ${this.context.metadata()?.headers[issue.col] || t('Column {number}', { number: issue.col + 1 })}` : ''}${issue.value ? ` · ${issue.value.slice(0, 120)}` : ''}`;
      button.dataset.tooltip = t('Click: locate this issue in the table'); button.onclick = () => { void this.go(index); };
      row.append(checkbox, button); return row;
    }));
    this.list.scrollTop = scroll;
  }

  private async runCheck(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.update();
    try {
      await this.context.prepare();
      const revision = this.revision, kind = this.kind.value as CheckKind, column = this.column.value;
      const result = await this.context.check(kind, column === 'all' || kind === 'ragged' ? undefined : [Number(column)]);
      this.result = result; this.checked.clear(); this.current = -1;
      this.page = 0; this.starts.splice(0, this.starts.length, { offset: 0 }); this.pages.clear(); this.pages.set(0, result);
      this.stale = revision !== this.revision; this.optionChange = false; this.drawResults();
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.update(); }
  }

  private async navigate(direction: number): Promise<void> {
    const target = this.current + direction;
    if (target >= 0 && target < (this.result?.issues.length ?? 0)) { await this.go(target); return; }
    const nextPage = this.page + direction;
    if (nextPage < 0 || (!this.result?.truncated && direction > 0)) return;
    await this.act(async () => {
      const revision = this.revision;
      if (direction > 0 && !this.starts[nextPage]) {
        const last = this.result!.issues.at(-1); if (!last) return;
        this.starts[nextPage] = { after: { row: last.row, col: last.col }, offset: this.starts[this.page]!.offset + this.result!.issues.length };
      }
      let result = this.pages.get(nextPage);
      if (!result) {
        const kind = this.kind.value as CheckKind, column = this.column.value;
        result = await this.context.check(kind, column === 'all' || kind === 'ragged' ? undefined : [Number(column)], this.starts[nextPage]!.after);
      }
      if (revision !== this.revision || this.stale) return;
      if (!result.issues.length) { this.error = 'No more check results. Run check again to refresh.'; return; }
      this.page = nextPage; this.result = result; this.checked.clear(); this.current = -1;
      this.pages.delete(nextPage); this.pages.set(nextPage, result);
      while (this.pages.size > 3) this.pages.delete(this.pages.keys().next().value!);
      this.drawResults();
      const index = direction > 0 ? 0 : result.issues.length - 1;
      await this.context.locate(result.issues[index]!.row, result.issues[index]!.col);
      this.current = index; this.list.children[index]?.scrollIntoView({ block: 'nearest' });
    });
  }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.stale) return;
    const focused = document.activeElement as HTMLElement | null;
    this.busy = true; this.error = ''; this.update();
    try {
      await this.context.prepare();
      if (this.stale) return;
      await action();
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally {
      this.busy = false; this.update();
      if (focused && this.element.contains(focused) && !this.element.hidden) focused.focus({ preventScroll: true });
    }
  }

  private async go(index: number): Promise<void> {
    const issue = this.result?.issues[index]; if (!issue) return;
    await this.act(async () => {
      await this.context.locate(issue.row, issue.col); this.current = index;
      this.list.children[index]?.scrollIntoView({ block: 'nearest' });
    });
  }

  private async selectCheckedCells(): Promise<void> {
    const issues = [...this.checked].map(index => this.result!.issues[index]!);
    await this.act(() => this.context.selectIssues(issues));
  }
}
