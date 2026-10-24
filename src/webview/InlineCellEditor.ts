/*
Edit a full CSV value in a viewport-bounded overlay anchored to its table cell.
*/
import { locale, t } from '../Locale';

type Edit = { value: string; label: string; anchor: () => DOMRect | null; commit: (value: string) => Promise<void> };

export class InlineCellEditor {
  readonly element = document.createElement('div');
  readonly input = document.createElement('textarea');
  private readonly error = document.createElement('div');
  private edit?: Edit;
  private pending?: Promise<boolean>;
  private message = '';

  constructor(root: HTMLElement, private readonly closed: (restoreFocus: boolean) => void) {
    this.element.className = 'inline-cell-editor'; this.element.hidden = true;
    this.element.setAttribute('role', 'group');
    this.input.className = 'inline-cell-input'; this.input.spellcheck = false;
    this.error.className = 'inline-cell-error'; this.error.setAttribute('role', 'alert');
    this.element.append(this.input, this.error); root.append(this.element);
    this.input.addEventListener('input', () => this.position());
    this.input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); }
      else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); void this.commit(true);
      }
    });
    document.addEventListener('pointerdown', event => {
      if (this.open && !this.element.contains(event.target as Node)) void this.commit(false);
    }, true);
    document.addEventListener('scroll', event => {
      if (this.open && !this.element.contains(event.target as Node)) void this.commit(false);
    }, true);
    window.addEventListener('resize', () => this.position());
    locale.subscribe(() => this.translate()); this.translate();
  }

  get open(): boolean { return this.edit !== undefined; }

  show(edit: Edit): void {
    if (this.open) throw new Error('Finish editing the current cell first.');
    this.edit = edit; this.message = ''; this.input.value = edit.value;
    this.input.readOnly = false; this.element.hidden = false; this.translate(); this.position();
    this.input.focus({ preventScroll: true }); this.input.select();
  }

  commit(restoreFocus = false): Promise<boolean> {
    if (this.pending) return this.pending;
    const edit = this.edit;
    if (!edit) return Promise.resolve(true);
    this.input.readOnly = true;
    this.pending = (async () => {
      try {
        if (this.input.value !== edit.value) await edit.commit(this.input.value);
        this.finish(restoreFocus); return true;
      } catch (error) {
        this.message = error instanceof Error ? error.message : String(error);
        this.input.readOnly = false; this.translate(); this.position();
        this.input.focus({ preventScroll: true }); return false;
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  cancel(): void { if (!this.pending) this.finish(true); }

  private finish(restoreFocus: boolean): void {
    this.edit = undefined; this.element.hidden = true; this.closed(restoreFocus);
  }

  private translate(): void {
    this.input.setAttribute('aria-label', t('Cell value'));
    this.element.setAttribute('aria-label', t('Edit {cell}', { cell: this.edit?.label ?? '' }));
    this.input.dataset.tooltip = t('Enter: apply · Shift+Enter: new line · Esc: cancel');
    this.error.textContent = t(this.message); this.error.hidden = !this.message;
  }

  private position(): void {
    if (!this.edit || this.element.hidden) return;
    const anchor = this.edit.anchor(); if (!anchor) return;
    const margin = 5, toolbar = document.querySelector('.toolbar')?.getBoundingClientRect().bottom ?? margin;
    const bottom = document.querySelector('.status')?.getBoundingClientRect().top ?? innerHeight - margin;
    const minTop = Math.min(innerHeight - 36, Math.max(margin, toolbar));
    const maxBottom = Math.max(minTop + 30, bottom - margin);
    const context = document.createElement('canvas').getContext('2d');
    if (context) context.font = getComputedStyle(this.input).font;
    let textWidth = 0;
    for (const line of this.input.value.slice(0, 65536).split(/\r\n|\r|\n/)) {
      textWidth = Math.max(textWidth, context?.measureText(line.slice(0, 8192)).width ?? line.length * 8);
    }
    const maxWidth = Math.max(40, innerWidth - margin * 2);
    const width = Math.min(maxWidth, Math.max(Math.min(anchor.width, maxWidth), Math.min(textWidth + 30, 720)));
    const left = Math.max(margin, Math.min(anchor.left, innerWidth - width - margin));
    this.element.style.width = `${width}px`; this.element.style.left = `${left}px`;
    this.input.style.height = '1px';
    const errorHeight = this.message ? this.error.scrollHeight + 8 : 0;
    const height = Math.min(Math.max(30, this.input.scrollHeight + 2), maxBottom - minTop - errorHeight);
    const top = Math.max(minTop, Math.min(anchor.top, maxBottom - height - errorHeight));
    this.element.style.top = `${top}px`; this.input.style.height = `${height}px`;
  }
}
