/*
Decorate CSV fields and delimiters with color and display-only alignment widgets.
*/
import { StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { CsvTextMetrics } from './CsvTextMetrics';
import { CsvTextLayout } from './CsvTextLayout';

class AlignmentSpace extends WidgetType {
  constructor(private readonly width: number) { super(); }
  eq(other: AlignmentSpace): boolean { return other.width === this.width; }
  toDOM(): HTMLElement {
    const space = document.createElement('span'); space.className = 'csv-alignment-space';
    space.style.width = `${this.width}px`; space.setAttribute('aria-hidden', 'true'); return space;
  }
  ignoreEvent(): boolean { return true; }
}

class AlignmentTab extends WidgetType {
  constructor(private readonly width: number) { super(); }
  eq(other: AlignmentTab): boolean { return other.width === this.width; }
  toDOM(): HTMLElement {
    const tab = document.createElement('span'); tab.className = 'csv-alignment-tab'; tab.textContent = '\t'; tab.style.width = `${this.width}px`; return tab;
  }
  ignoreEvent(): boolean { return false; }
}

const typographyChanged = StateEffect.define<void>();

export function csvTextDecorations(delimiter: string, aligned: boolean, collapsed = false) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    private readonly observer: MutationObserver;
    private stopped = false;
    private readonly refresh: () => void;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
      this.refresh = () => { if (!this.stopped) view.dispatch({ effects: typographyChanged.of() }); };
      this.observer = new MutationObserver(this.refresh);
      for (const element of [document.documentElement, document.body]) this.observer.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
      document.fonts.addEventListener('loadingdone', this.refresh);
      void document.fonts.ready.then(this.refresh);
    }
    destroy(): void { this.stopped = true; this.observer.disconnect(); document.fonts.removeEventListener('loadingdone', this.refresh); }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.geometryChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(typographyChanged)))) this.decorations = this.build(update.view);
    }
    private build(view: EditorView): DecorationSet {
      const metrics = new CsvTextMetrics(view.contentDOM, view.state.tabSize);
      const text = view.state.doc.toString();
      const layout = new CsvTextLayout(text, delimiter, text => metrics.width(text), collapsed);
      const ranges = layout.fields.flatMap(field => {
        const result = [];
        if (field.to > field.from) result.push(Decoration.mark({ class: `csv-text-column-${field.column % 8}` }).range(field.from, field.to));
        if (aligned) for (const continuation of field.continuations) if (continuation.padding) result.push(Decoration.widget({ widget: new AlignmentSpace(continuation.padding), side: -1 }).range(continuation.at));
        if (field.separator !== undefined) {
          if (aligned && field.padding) result.push(Decoration.widget({ widget: new AlignmentSpace(field.padding), side: -1 }).range(field.separator));
          result.push(Decoration.mark({ class: 'csv-text-delimiter' }).range(field.separator, field.separator + 1));
        }
        return result;
      });
      if (aligned) for (const match of text.matchAll(/\t/g)) ranges.push(Decoration.replace({ widget: new AlignmentTab(metrics.tabWidth) }).range(match.index!, match.index! + 1));
      return Decoration.set(ranges, true);
    }
  }, { decorations: value => value.decorations });
}
