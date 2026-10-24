/*
Collapse quoted field line breaks visually while retaining editable CSV source positions.
*/
import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { CsvTextLayout, FOLDED_NEWLINE } from './CsvTextLayout';

class FoldedNewline extends WidgetType {
  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = 'csv-folded-newline'; marker.textContent = FOLDED_NEWLINE;
    return marker;
  }
}

export function csvTextFolding(delimiter: string) {
  const build = (text: string): DecorationSet => Decoration.set(new CsvTextLayout(text, delimiter).fields.flatMap(field =>
    field.continuations.map(({ at }) => Decoration.replace({ widget: new FoldedNewline() }).range(at - (text[at - 2] === '\r' ? 2 : 1), at)),
  ), true);
  return StateField.define<DecorationSet>({
    create: state => build(state.doc.toString()),
    update: (value, transaction) => transaction.docChanged ? build(transaction.newDoc.toString()) : value,
    provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
  });
}
