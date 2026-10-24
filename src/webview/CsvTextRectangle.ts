/*
Map rectangular selections to CSV screen positions, including alignment padding.
*/
import { EditorSelection } from '@codemirror/state';
import { CsvTextMetrics } from './CsvTextMetrics';
import { CsvTextLayout, FOLDED_NEWLINE } from './CsvTextLayout';
import { EditorView, type ViewUpdate } from '@codemirror/view';

export class CsvTextRectangle {
  private anchor: number;
  private readonly x: number;
  private readonly scrollLeft: number;
  private selection: EditorSelection;
  private padding = new Map<number, number>();
  private readonly metrics: CsvTextMetrics;

  constructor(private readonly view: EditorView, event: MouseEvent, private readonly separator: string, private readonly collapsed = false, private readonly aligned = true) {
    this.anchor = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    this.x = event.clientX; this.scrollLeft = view.scrollDOM.scrollLeft;
    this.selection = view.state.selection;
    this.metrics = new CsvTextMetrics(view.contentDOM, view.state.tabSize);
    this.readPadding();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.anchor = update.changes.mapPos(this.anchor);
      this.selection = this.selection.map(update.changes);
      this.readPadding();
    }
  }

  private readPadding(): void {
    if (!this.aligned) { this.padding.clear(); return; }
    const layout = new CsvTextLayout(this.view.state.doc.toString(), this.separator, text => this.metrics.width(text), this.collapsed);
    this.padding = new Map(layout.fields.filter(field => field.separator !== undefined).map(field => [field.separator!, field.padding]));
    for (const field of layout.fields) for (const continuation of field.continuations) this.padding.set(continuation.at, continuation.padding);
  }

  private offscreenPosition(from: number, text: string, x: number): number {
    const { view } = this;
    const element = view.contentDOM.querySelector('.cm-line') ?? view.contentDOM;
    const style = getComputedStyle(element);
    let left = element.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft || '0');
    let offset = 0;
    for (const character of text) {
      left += (this.padding.get(from + offset) ?? 0);
      const width = this.metrics.width(this.collapsed && character === '\n' ? FOLDED_NEWLINE : character);
      if (x < left + width / 2) return from + offset;
      left += width; offset += character.length;
    }
    return from + text.length;
  }

  get(event: MouseEvent, _extend: boolean, multiple: boolean): EditorSelection {
    const { view } = this;
    const current = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    const first = view.state.doc.lineAt(this.anchor).number, last = view.state.doc.lineAt(current).number;
    const anchorX = this.x + this.scrollLeft - view.scrollDOM.scrollLeft;
    const ranges = [];
    const seen = new Set<number>();
    for (let number = Math.min(first, last); number <= Math.max(first, last); number++) {
      const line = view.state.doc.line(number), block = view.lineBlockAt(line.from);
      if (seen.has(block.from)) continue;
      seen.add(block.from);
      const from = this.collapsed ? block.from : line.from, to = this.collapsed ? block.to : line.to;
      const y = view.documentTop + block.top + block.height / 2;
      const position = (x: number) => Math.max(from, Math.min(to, view.posAtCoords({ x, y }) ?? this.offscreenPosition(from, view.state.doc.sliceString(from, to), x)));
      ranges.push(EditorSelection.range(position(anchorX), position(event.clientX)));
    }
    return EditorSelection.create(multiple ? [...ranges, ...this.selection.ranges] : ranges);
  }
}
