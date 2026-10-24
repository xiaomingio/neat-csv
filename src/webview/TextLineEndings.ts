/*
Normalize editor line breaks to LF while preserving each original CSV line-ending sequence through edits.
*/
import type { ChangeSet } from '@codemirror/state';

export class TextLineEndings {
  private endings = new Map<number, string>();
  readonly text: string;
  constructor(raw: string, private readonly defaultEnding: string) {
    let removed = 0;
    for (const match of raw.matchAll(/\r\n|\r|\n/g)) {
      this.endings.set(match.index! - removed, match[0]); removed += match[0].length - 1;
    }
    this.text = raw.replace(/\r\n|\r/g, '\n');
  }

  update(changes: ChangeSet): void {
    const deleted: { from: number; to: number }[] = [];
    changes.iterChangedRanges((from, to) => { if (to > from) deleted.push({ from, to }); });
    const next = new Map<number, string>();
    for (const [position, ending] of this.endings) {
      if (!deleted.some(range => position >= range.from && position < range.to)) next.set(changes.mapPos(position, 1), ending);
    }
    changes.iterChanges((_from, _to, from, _end, inserted) => {
      for (const match of inserted.toString().matchAll(/\n/g)) next.set(from + match.index!, this.defaultEnding);
    });
    this.endings = next;
  }

  serialize(text: string, offset = 0): string {
    return text.replace(/\n/g, (_match, index: number) => this.endings.get(offset + index) ?? this.defaultEnding);
  }
}
