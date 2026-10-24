/*
File purpose: Verify table clipboard ordering, selection stability, failure protection, and cut undo against the real CSV engine.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvFile } from '../src/engine/CsvFile';
import { TableClipboard, type TableClipboardContext, type TableClipboardSnapshot } from '../src/webview/TableClipboard';
import type { ChangeOperation, ChangeResult } from '../src/protocol';

function fixtureContext(overrides: Partial<TableClipboardContext> = {}) {
  const snapshot: TableClipboardSnapshot = { version: 1, selection: { start: 2, count: 3, columns: [2, 0], ranges: [{ start: 2, count: 1 }, { start: 4, count: 1 }] }, pasteColumns: [2, 0, 1] };
  const operations: ChangeOperation[] = [], statuses: (string | null)[] = [], writes: string[] = [], copied: { snapshot: TableClipboardSnapshot; mode: 'copy' | 'cut' }[] = [];
  const context: TableClipboardContext = {
    capture: () => snapshot, current: value => value.version === snapshot.version,
    copy: async () => 'complete\tvalue', read: async () => 'incoming\ttext',
    write: async text => { writes.push(text); }, change: async operation => { operations.push(operation); },
    copied: (snapshot, mode) => { copied.push({ snapshot, mode }); }, busy: label => { statuses.push(label); }, ...overrides,
  };
  return { clipboard: new TableClipboard(context), snapshot, context, operations, statuses, writes, copied };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('Cut writes complete TSV before one fill transaction and releases its operation lock', async () => {
  const order: string[] = [];
  const fixture = fixtureContext({ write: async () => { order.push('write'); }, change: async operation => { order.push('change'); assert.equal(operation.kind, 'fill'); if (operation.kind === 'fill') { assert.equal(operation.value, ''); assert.deepEqual(operation.selection.columns, [2, 0]); assert.deepEqual(operation.selection.ranges, [{ start: 2, count: 1 }, { start: 4, count: 1 }]); } } });
  await fixture.clipboard.cut();
  assert.deepEqual(order, ['write', 'change']);
  assert.equal(fixture.copied[0].mode, 'cut');
  assert.deepEqual(fixture.copied[0].snapshot.selection, fixture.snapshot.selection);
  assert.deepEqual(fixture.statuses, ['Cutting…', null]); assert.equal(fixture.clipboard.busy, false);
});

test('Clipboard write failure never clears cells; a later operation can retry', async () => {
  let fail = true;
  const fixture = fixtureContext({ write: async () => { if (fail) throw new Error('Clipboard unavailable'); } });
  await assert.rejects(fixture.clipboard.cut(), /Clipboard unavailable/);
  assert.deepEqual(fixture.operations, []); assert.deepEqual(fixture.copied, []); assert.equal(fixture.clipboard.busy, false);
  fail = false; await fixture.clipboard.cut(); assert.equal(fixture.operations.length, 1);
});

test('Changing the selection or query during an asynchronous write cancels cut without clearing any cells', async () => {
  const write = deferred<void>(), fixture = fixtureContext({ write: () => write.promise });
  const operation = fixture.clipboard.cut();
  await Promise.resolve();
  fixture.snapshot.version = 2; fixture.snapshot.selection.columns[0] = 1;
  write.resolve(); await assert.rejects(operation, /selection changed/);
  assert.deepEqual(fixture.operations, []); assert.equal(fixture.clipboard.busy, false);
});

test('Copy captures immutable coordinates, checks for stale results, and prevents overlapping operations', async () => {
  const copy = deferred<string>(); let captured: number[] = [];
  const fixture = fixtureContext({ copy: selection => { captured = [...selection.columns]; return copy.promise; } });
  const operation = fixture.clipboard.copy();
  await assert.rejects(fixture.clipboard.paste(), /Wait for the clipboard/);
  fixture.snapshot.selection.columns[0] = 1; fixture.snapshot.version = 2;
  copy.resolve('old selection'); await assert.rejects(operation, /selection changed/);
  assert.deepEqual(captured, [2, 0]); assert.deepEqual(fixture.writes, []);
});

test('Copy marks its captured source only after a successful current clipboard write', async () => {
  const write = deferred<void>(), fixture = fixtureContext({ write: () => write.promise });
  const operation = fixture.clipboard.copy();
  await Promise.resolve(); assert.equal(fixture.copied.length, 0);
  write.resolve(); await operation;
  assert.equal(fixture.copied[0].mode, 'copy');
  assert.deepEqual(fixture.copied[0].snapshot.selection.columns, [2, 0]);
  const staleWrite = deferred<void>(), stale = fixtureContext({ write: () => staleWrite.promise });
  const staleOperation = stale.clipboard.copy();
  await Promise.resolve(); stale.snapshot.version = 2; staleWrite.resolve();
  await assert.rejects(staleOperation, /selection changed/); assert.deepEqual(stale.copied, []);
  const failed = fixtureContext({ change: async () => { throw new Error('Cannot change'); } });
  await assert.rejects(failed.clipboard.cut(), /Cannot change/); assert.deepEqual(failed.copied, []);
});

test('Paste reads native clipboard content and preserves destination coordinates; supplied text bypasses reads', async () => {
  let reads = 0;
  const fixture = fixtureContext({ read: async () => { reads++; return 'a\t"line1\nline2"'; } });
  await fixture.clipboard.paste();
  assert.deepEqual(fixture.operations[0], { kind: 'paste', row: 2, columns: [2, 0, 1], text: 'a\t"line1\nline2"' });
  await fixture.clipboard.paste(''); assert.equal(reads, 1);
  assert.deepEqual(fixture.operations[1], { kind: 'paste', row: 2, columns: [2, 0, 1], text: '' });
  const read = deferred<string>(), stale = fixtureContext({ read: () => read.promise });
  const operation = stale.clipboard.paste(); stale.snapshot.version = 9; read.resolve('text');
  await assert.rejects(operation, /selection changed/); assert.deepEqual(stale.operations, []);
});

test('Copying selected text writes only the text and never modifies CSV cells', async () => {
  const fixture = fixtureContext({ capture: () => undefined });
  await fixture.clipboard.copyText('part of a URL');
  assert.deepEqual(fixture.writes, ['part of a URL']); assert.deepEqual(fixture.operations, []); assert.deepEqual(fixture.copied, []);
  await assert.rejects(fixture.clipboard.cut(), /Select cells/); assert.deepEqual(fixture.operations, []);
});

test('Irregular sparse clipboard selections are rejected before clipboard IO or cell mutation', async () => {
  const selection = { start: 0, count: 2, columns: [0, 1], cells: [{ row: 0, col: 0 }, { row: 1, col: 1 }] };
  let reads = 0;
  const fixture = fixtureContext({ capture: () => ({ selection, version: 1, pasteColumns: [0, 1] }), read: async () => { reads++; return 'unexpected'; } });
  for (const action of ['copy', 'cut', 'paste'] as const) await assert.rejects(fixture.clipboard[action](), /rectangular selection/);
  assert.equal(reads, 0); assert.deepEqual(fixture.writes, []); assert.deepEqual(fixture.operations, []);
  const captured: TableClipboardSnapshot[] = [];
  const complete = fixtureContext({
    capture: () => ({ selection: { start: 0, count: 1, columns: [0], cells: [{ row: 0, col: 0 }] }, version: 1, pasteColumns: [0] }),
    copied: snapshot => { captured.push(snapshot); },
  });
  await complete.clipboard.copy(); assert.deepEqual(captured[0].selection.cells, [{ row: 0, col: 0 }]);
});

test('Real-engine cut preserves sorted visual column order, quoted multiline TSV, hidden cells, source bytes, and one-step undo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-table-clipboard-')), path = join(directory, 'input.csv');
  const original = 'name,hidden,note,n\nA,keepA,"first\nline",2\nB,keepB,"tab\tquote""",1\n';
  await writeFile(path, original);
  const file = new CsvFile(path);
  try {
    await file.open(); await file.search({ text: 'A' });
    await file.query({ filters: [], sort: { col: 3, direction: 1, numeric: true } });
    const selection = { start: 0, count: 2, columns: [2, 0] };
    let content = '', result: ChangeResult | undefined, changes = 0;
    const clipboard = new TableClipboard({
      capture: () => ({ selection, version: 1, pasteColumns: [2, 0, 3] }), current: snapshot => snapshot.version === 1,
      copy: value => file.copy(value.start, value.count, value.columns, value.ranges),
      read: async () => content, write: async value => { content = value; },
      change: async operation => { result = await file.change(operation); changes++; }, copied: () => {}, busy: () => {},
    });
    await clipboard.cut();
    assert.equal(content, '"tab\tquote"""\tB\n"first\nline"\tA');
    assert.equal(changes, 1);
    await file.query({ filters: [], sort: null });
    assert.deepEqual((await file.page(0, 2)).rows.map(row => row.values), [['', 'keepA', '', '2'], ['', 'keepB', '', '1']]);
    assert.equal(await readFile(path, 'utf8'), original);
    await file.restore(result!.before);
    assert.deepEqual((await file.page(0, 2)).rows.map(row => row.values), [['A', 'keepA', 'first\nline', '2'], ['B', 'keepB', 'tab\tquote"', '1']]);
    assert.equal(file.changes, 0);
  } finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Copy with headers uses one immutable selection and keeps plain Copy and Cut content-only', async () => {
  const modes: (boolean | undefined)[] = [];
  const fixture = fixtureContext({ copy: async (_selection, includeHeaders) => {
    modes.push(includeHeaders);
    return includeHeaders ? 'Header\nvalue' : 'value';
  } });
  await fixture.clipboard.copy(true);
  await fixture.clipboard.copy();
  await fixture.clipboard.cut();
  assert.deepEqual(modes, [true, false, undefined]);
  assert.deepEqual(fixture.writes, ['Header\nvalue', 'value', 'value']);
  assert.equal(fixture.copied[0].mode, 'copy');
});

test('Header copy follows filtered rows and requested column order and quotes multiline headers and values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-header-copy-'));
  const path = join(directory, 'input.csv');
  const source = '"Name\tlabel",Count,"Note\nheading"\nA,2,"first\nline"\nB,1,"say ""hello"""\nC,3,other\n';
  await writeFile(path, source);
  const file = new CsvFile(path);
  try {
    await file.open();
    await file.query({ filters: [{ col: 0, type: 'regex', text: 'A|B' }], sort: { col: 1, numeric: true, direction: 1 } });
    assert.equal(await file.copy(0, 2, [2, 0], undefined, undefined, true),
      '"Note\nheading"\t"Name\tlabel"\n"say ""hello"""\tB\n"first\nline"\tA');
    assert.equal(await file.copy(0, 1, [2], undefined, undefined, true), '"Note\nheading"\n"say ""hello"""');
    assert.equal(await file.copy(0, 1, [2]), 'say "hello"');
    assert.equal(await readFile(path, 'utf8'), source);
    assert.equal(file.changes, 0);
  } finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
});
