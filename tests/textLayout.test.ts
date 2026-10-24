/*
Purpose: Verify CSV continuation positions and lossless mixed newline preservation after editing.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, Text } from '@codemirror/state';
import { CsvTextLayout } from '../src/webview/CsvTextLayout';
import { TextLineEndings } from '../src/webview/TextLineEndings';

test('quoted multiline continuations begin in their CSV column with measured Unicode widths', () => {
  const text = 'ID,Name,Note,Last\r\n1,東京,"first\n中文\nlast",tail\r\n2,abcdef,short,end\r\n';
  const measure = (text: string) => [...text].reduce((sum, character) => sum + (/[^\x00-\x7f]/.test(character) ? 13 : 7.8), 0);
  const layout = new CsvTextLayout(text, ',', measure);
  const fields = layout.fields.filter(field => field.column === 2);
  const note = fields[1];
  assert.equal(note.continuations.length, 2);
  assert.equal(note.continuations[0].padding, note.continuations[1].padding);
  assert.ok(Math.abs(note.continuations[0].padding - 93.6) < 0.0001);
  assert.ok(Math.abs(note.padding - 15.6) < 0.0001);
  assert.ok(Math.abs(layout.fields[5].padding - 28.6) < 0.0001);
  assert.equal(layout.records.length, 4);
});

test('mixed record CRLF and quoted LF survive edits, inserted-break removal, and buffer slices', () => {
  const raw = 'A,B\r\n1,"hello\nworld"\r\n2,end\r\n';
  const endings = new TextLineEndings(raw, '\r\n');
  assert.equal(endings.serialize(endings.text), raw);
  let text = endings.text;
  const position = text.indexOf('hello');
  const change = ChangeSet.of({ from: position, insert: 'new\n' }, text.length);
  endings.update(change); text = change.apply(Text.of(text.split('\n'))).toString();
  assert.equal(endings.serialize(text), 'A,B\r\n1,"new\r\nhello\nworld"\r\n2,end\r\n');
  const undo = ChangeSet.of({ from: position, to: position + 4 }, text.length);
  endings.update(undo); text = text.slice(0, position) + text.slice(position + 4);
  assert.equal(endings.serialize(text), raw);
  const from = text.indexOf('1,');
  assert.equal(endings.serialize(text.slice(from), from), raw.slice(raw.indexOf('1,')));
});

test('native text-history restore remounts original mixed endings after deleting a quoted line break', () => {
  const before = 'ID,Note\r\n1,"hello\nworld"\r\n';
  const current = new TextLineEndings(before, '\r\n');
  const at = current.text.indexOf('\n', current.text.indexOf('hello'));
  current.update(ChangeSet.of({ from: at, to: at + 1 }, current.text.length));
  const edited = current.serialize(current.text.slice(0, at) + current.text.slice(at + 1));
  assert.equal(edited, 'ID,Note\r\n1,"helloworld"\r\n');
  const undo = new TextLineEndings(before, '\r\n');
  assert.equal(undo.serialize(undo.text), before);
  const redo = new TextLineEndings(edited, '\r\n');
  assert.equal(redo.serialize(redo.text), edited);
});
