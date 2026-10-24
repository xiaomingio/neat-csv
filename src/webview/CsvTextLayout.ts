/*
Parse quoted CSV fields and calculate display-only column alignment and continuation indentation.
*/
export type CsvTextField = { from: number; to: number; column: number; separator?: number; padding: number; continuations: { at: number; padding: number }[] };
export const FOLDED_NEWLINE = '↵';

export class CsvTextLayout {
  readonly fields: CsvTextField[] = [];
  readonly records: number[] = [0];

  constructor(text: string, delimiter: string, measure?: (text: string) => number, collapsed = false) {
    let quoted = false, start = 0, column = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '"') {
        if (quoted && text[index + 1] === '"') index++;
        else quoted = !quoted;
      } else if (!quoted && character === delimiter) {
        this.fields.push({ from: start, to: index, column: column++, separator: index, padding: 0, continuations: [] }); start = index + 1;
      } else if (!quoted && (character === '\n' || character === '\r')) {
        this.fields.push({ from: start, to: index, column, padding: 0, continuations: [] });
        if (character === '\r' && text[index + 1] === '\n') index++;
        this.records.push(index + 1);
        start = index + 1; column = 0;
      }
    }
    if (this.records.at(-1) !== text.length) this.records.push(text.length);
    if (start < text.length || column) this.fields.push({ from: start, to: text.length, column, padding: 0, continuations: [] });
    const width = measure ?? ((value: string) => [...value].reduce((sum, character) => sum + (character === '\t' ? 4 : character === '\ufeff' ? 0 : /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]|\p{Extended_Pictographic}/u.test(character) ? 2 : 1), 0));
    const gap = width(' '), separatorWidth = width(delimiter);
    const widths: number[] = [];
    const lines = this.fields.map(field => {
      const value = text.slice(field.from, field.to);
      return (collapsed ? [value.replace(/\r\n|\n|\r/g, FOLDED_NEWLINE)] : value.split(/\r\n|\n|\r/)).map(width);
    });
    this.fields.forEach((field, index) => { widths[field.column] = Math.max(widths[field.column] ?? 0, ...lines[index]); });
    const starts: number[] = [], ends: number[] = []; let offset = 0;
    widths.forEach((size, index) => { starts[index] = offset; ends[index] = offset + size + gap; offset = ends[index] + separatorWidth; });
    let current = 0;
    this.fields.forEach((field, index) => {
      if (field.column === 0) current = 0;
      for (const match of (collapsed ? '' : text.slice(field.from, field.to)).matchAll(/\r\n|\r|\n/g)) {
        field.continuations.push({ at: field.from + match.index! + match[0].length, padding: starts[field.column] });
      }
      current = lines[index].length > 1 ? starts[field.column] + lines[index].at(-1)! : current + lines[index][0];
      if (field.separator !== undefined) {
        field.padding = Math.max(0, ends[field.column] - current);
        current += field.padding + separatorWidth;
      }
    });
  }
}
