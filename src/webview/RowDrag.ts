/*
File purpose: Coordinate row-handle dragging, a bounded row preview, insertion feedback, and edge scrolling.
*/
export type RowDragTarget = { row: number; index: number; element: HTMLElement };
export type RowDragContext = {
  root: HTMLElement;
  viewport: HTMLElement;
  allowed(): boolean;
  rowAtPointer(x: number, y: number): RowDragTarget | undefined;
  total(): number;
  move(row: number, before: number): Promise<void>;
  scroll?(delta: number): void;
  error?(message: string): void;
};

type DragState = {
  pointer: number; row: number; source: HTMLElement; x: number; y: number;
  startY: number; offset: number; dragging: boolean; before?: number;
};

export class RowDrag {
  private state?: DragState;
  private preview?: HTMLElement;
  private indicator?: HTMLElement;
  private frame = 0;
  private lastFrame = 0;

  constructor(private readonly context: RowDragContext) {}
  get active(): boolean { return Boolean(this.state); }

  attach(handle: HTMLElement, row: number): void {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      if (this.state || !this.context.allowed()) return;
      const source = handle.closest<HTMLElement>('.grid-row');
      if (!source) return;
      this.state = { pointer: event.pointerId, row, source, x: event.clientX, y: event.clientY,
        startY: event.clientY, offset: event.clientY - source.getBoundingClientRect().top, dragging: false };
      document.addEventListener('pointermove', this.movePointer, true);
      document.addEventListener('pointerup', this.release, true);
      document.addEventListener('pointercancel', this.cancelPointer, true);
      document.addEventListener('keydown', this.keydown, true);
      window.addEventListener('blur', this.blur);
    });
    handle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
  }

  cancel(): void {
    this.state = undefined;
    cancelAnimationFrame(this.frame); this.frame = 0; this.lastFrame = 0;
    this.preview?.remove(); this.preview = undefined;
    this.indicator?.remove(); this.indicator = undefined;
    this.context.root.classList.remove('row-dragging');
    document.removeEventListener('pointermove', this.movePointer, true);
    document.removeEventListener('pointerup', this.release, true);
    document.removeEventListener('pointercancel', this.cancelPointer, true);
    document.removeEventListener('keydown', this.keydown, true);
    window.removeEventListener('blur', this.blur);
  }

  private movePointer = (event: PointerEvent): void => {
    const state = this.state;
    if (!state || event.pointerId !== state.pointer) return;
    event.preventDefault(); event.stopPropagation();
    state.x = event.clientX; state.y = event.clientY;
    if (!state.dragging && Math.abs(state.y - state.startY) >= 4) this.beginPreview();
    if (state.dragging) { this.update(); if (!this.frame) this.frame = requestAnimationFrame(this.animate); }
  };

  private beginPreview(): void {
    const state = this.state!;
    if (!this.context.allowed()) { this.cancel(); return; }
    if (!state.source.isConnected) {
      const source = this.context.root.querySelector<HTMLElement>(`.grid-row .cell[data-row="${state.row}"]`)?.closest<HTMLElement>('.grid-row');
      if (!source) { this.cancel(); return; }
      state.source = source;
    }
    state.dragging = true;
    window.getSelection()?.removeAllRanges();
    this.context.root.classList.add('row-dragging');
    const bounds = this.context.viewport.getBoundingClientRect();
    this.preview = document.createElement('div'); this.preview.className = 'row-drag-preview';
    this.preview.setAttribute('aria-hidden', 'true');
    for (const cell of state.source.children) {
      if (!(cell instanceof HTMLElement)) continue;
      const rect = cell.getBoundingClientRect(), clone = cell.cloneNode(true) as HTMLElement;
      clone.classList.remove('selected', 'axis-selected');
      clone.style.position = 'absolute'; clone.style.left = `${rect.left - bounds.left}px`; clone.style.top = '0'; clone.style.width = `${rect.width}px`;
      this.preview.append(clone);
    }
    this.preview.style.height = `${Math.min(state.source.getBoundingClientRect().height, bounds.height)}px`;
    this.indicator = document.createElement('div'); this.indicator.className = 'row-drop-indicator';
    this.indicator.setAttribute('aria-hidden', 'true');
    this.context.root.append(this.preview, this.indicator);
  }

  private update(): void {
    const state = this.state;
    if (!state?.dragging || !this.preview || !this.indicator) return;
    const bounds = this.context.viewport.getBoundingClientRect();
    const x = Math.max(bounds.left + 1, Math.min(bounds.right - 1, state.x));
    const y = Math.max(bounds.top + 1, Math.min(bounds.bottom - 2, state.y));
    this.preview.style.left = `${bounds.left}px`; this.preview.style.width = `${bounds.width}px`;
    this.preview.style.top = `${Math.max(bounds.top, Math.min(bounds.bottom - this.preview.offsetHeight, state.y - state.offset))}px`;
    const target = this.context.rowAtPointer(x, y);
    if (!target) { state.before = undefined; this.indicator.hidden = true; return; }
    const rect = target.element.getBoundingClientRect(), after = y > rect.top + rect.height / 2;
    state.before = Math.max(0, Math.min(this.context.total(), target.row + (after ? 1 : 0)));
    this.indicator.hidden = state.before === state.row || state.before === state.row + 1;
    this.indicator.style.left = `${bounds.left}px`; this.indicator.style.width = `${bounds.width}px`;
    this.indicator.style.top = `${Math.max(bounds.top, Math.min(bounds.bottom - 2, after ? rect.bottom : rect.top))}px`;
  }

  private animate = (time: number): void => {
    this.frame = 0;
    const state = this.state;
    if (!state?.dragging) return;
    if (!this.context.allowed()) { this.cancel(); return; }
    const bounds = this.context.viewport.getBoundingClientRect(), edge = Math.min(36, bounds.height / 4);
    const distance = state.y < bounds.top + edge ? state.y - bounds.top - edge : state.y > bounds.bottom - edge ? state.y - bounds.bottom + edge : 0;
    const elapsed = Math.min(40, this.lastFrame ? time - this.lastFrame : 16); this.lastFrame = time;
    if (distance) {
      const delta = Math.sign(distance) * Math.min(80, 2 + Math.abs(distance) * .45) * elapsed / 16;
      if (this.context.scroll) this.context.scroll(delta); else this.context.viewport.scrollTop += delta;
    }
    this.update(); this.frame = requestAnimationFrame(this.animate);
  };

  private release = (event: PointerEvent): void => {
    const state = this.state;
    if (!state || event.pointerId !== state.pointer) return;
    event.preventDefault(); event.stopPropagation();
    state.x = event.clientX; state.y = event.clientY;
    this.update();
    const before = state.before, valid = state.dragging && this.context.allowed();
    this.cancel();
    if (valid && before !== undefined && before !== state.row && before !== state.row + 1) {
      void this.context.move(state.row, before).catch(error => this.context.error?.(error instanceof Error ? error.message : String(error)));
    }
  };
  private cancelPointer = (event: PointerEvent): void => { if (event.pointerId === this.state?.pointer) this.cancel(); };
  private keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); } };
  private blur = (): void => { this.cancel(); };
}
