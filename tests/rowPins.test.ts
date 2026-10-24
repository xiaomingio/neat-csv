/*
File purpose: Verify transient pinned-row coordinates across queries, selection edits, recovery, and exports.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvFile } from '../src/engine/CsvFile';

async function fixture(run: (file: CsvFile, path: string, directory: string, original: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'csv-row-pins-')), path = join(directory, 'input.csv');
  const original = '\ufeffname,n\r\nA,1\r\nB,2\r\nC,3\r\nD,4';
  await writeFile(path, original);
  const file = new CsvFile(path);
  try { await file.open(); await file.query({ filters: [], sort: null }); await run(file, path, directory, original); }
  finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
}
const ids = async (file: CsvFile) => (await file.page(0, 20)).rows.map(row => row.id);

test('Pinned rows share one effective order for paging, locating, copying, statistics and selection search', async () => {
  await fixture(async (file, path, _directory, original) => {
    assert.deepEqual(await file.pinRows([3, 1, 3]), { rows: [3, 1], visibleRows: [3, 1], total: 4 });
    assert.deepEqual(await ids(file), [3, 1, 0, 2]);
    assert.deepEqual((await file.page(1, 2)).rows.map(row => row.id), [1, 0]);
    assert.deepEqual((await file.page(0, 1)).pinnedRows, [3, 1]);
    for (const [index, row] of [3, 1, 0, 2].entries()) assert.deepEqual(await file.locate(row), { row, index });
    assert.equal(await file.copy(0, 3, [1, 0]), '4\tD\n2\tB\n1\tA');
    assert.equal((await file.stats(0, 3, [1])).sum, 7);
    const selection = { start: 0, count: 4, columns: [0, 1], ranges: [{ start: 0, count: 1 }, { start: 3, count: 1 }], cells: [{ row: 0, col: 1 }, { row: 3, col: 0 }] };
    const stats = await file.stats(selection.start, selection.count, selection.columns, selection.ranges, selection.cells);
    assert.equal(stats.count, 2); assert.equal(stats.numericCount, 1); assert.equal(stats.sum, 4);
    const search = await file.search({ text: '.', regex: true, selection });
    assert.deepEqual(search.matches.map(match => [match.row, match.col]), [[2, 0], [3, 1]]);
    assert.deepEqual(await file.query({ filters: [], sort: { col: 1, direction: -1, numeric: true } }), { rows: [3, 1], visibleRows: [3, 1], total: 4 });
    assert.deepEqual(await ids(file), [3, 1, 2, 0]);
    const filtered = await file.query({ filters: [{ col: 1, type: 'number', operator: 'gte', value: 3 }], sort: { col: 1, direction: -1, numeric: true } });
    assert.deepEqual(filtered, { rows: [3, 1], visibleRows: [3], total: 2 });
    assert.deepEqual(await ids(file), [3, 2]); assert.deepEqual(await file.locate(1), { row: 1, index: null });
    await file.edit({ row: 3, col: 1, value: '1' }); assert.deepEqual(await ids(file), [2]); assert.deepEqual((await file.page(0, 1)).pinnedRows, []);
    await file.edit({ row: 3, col: 1, value: '4' }); assert.deepEqual(await ids(file), [3, 2]); assert.equal(file.changes, 0);
    await file.query({ filters: [], sort: null }); assert.deepEqual(await ids(file), [3, 1, 0, 2]);
    for (const rows of [[-1], [4], [.5], Array.from({ length: 101 }, () => 0)]) await assert.rejects(file.pinRows(rows), /100 valid rows/);
    assert.deepEqual(await ids(file), [3, 1, 0, 2]); assert.equal(file.changes, 0);
    await file.pinRows([]); assert.deepEqual(await ids(file), [0, 1, 2, 3]);
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

test('Pinned selection paste, sparse fill and replace edit source rows precisely, while undo and structure clear pins', async () => {
  await fixture(async (file, path, _directory, original) => {
    await file.pinRows([2, 0]);
    const pasted = await file.change({ kind: 'paste', row: 0, columns: [1, 0], text: '30\tC*\n10\tA*' });
    assert.deepEqual(pasted.metadata.pinnedRows, [2, 0]);
    assert.deepEqual((await file.page(0, 4)).rows.map(row => row.values), [['C*', '30'], ['A*', '10'], ['B', '2'], ['D', '4']]);
    const selection = { start: 0, count: 3, columns: [0, 1], ranges: [{ start: 0, count: 1 }, { start: 2, count: 1 }], cells: [{ row: 0, col: 0 }, { row: 2, col: 1 }] };
    const filled = await file.change({ kind: 'fill', selection, value: 'X' });
    assert.deepEqual((await file.page(0, 4)).rows.map(row => row.values), [['X', '30'], ['A*', '10'], ['B', 'X'], ['D', '4']]);
    await file.restore(filled.before);
    assert.deepEqual((await file.page(0, 1)).pinnedRows, []);
    assert.deepEqual((await file.page(0, 4)).rows.map(row => row.values), [['A*', '10'], ['B', '2'], ['C*', '30'], ['D', '4']]);
    await file.pinRows([2, 0]);
    await file.change({ kind: 'replace', search: { text: '*' }, replacement: '!', selection: { start: 0, count: 2, columns: [0] } });
    assert.deepEqual((await file.page(0, 4)).rows.map(row => row.values), [['C!', '30'], ['A!', '10'], ['B', '2'], ['D', '4']]);
    await file.change({ kind: 'paste', row: 3, columns: [0, 1], text: 'Dnew\t40\nEnew\t50' });
    assert.deepEqual(await ids(file), [2, 0, 1, 3, 4]);
    const moved = await file.change({ kind: 'moveColumn', col: 0, before: 2 });
    assert.deepEqual(moved.metadata.pinnedRows, []); assert.deepEqual(await ids(file), [0, 1, 2, 3, 4]);
    await file.pinRows([4]); await file.restore(pasted.before);
    assert.deepEqual((await file.page(0, 1)).pinnedRows, []); assert.equal(file.changes, 0);
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

test('Pinned views never reorder Text or saved data, and temporary export queries restore the effective view', async () => {
  await fixture(async (file, path, directory, original) => {
    await file.pinRows([3, 0]);
    await file.query({ filters: [{ col: 1, type: 'number', operator: 'gte', value: 2 }], sort: { col: 1, direction: 1, numeric: true } });
    const before = await file.page(0, 10);
    assert.deepEqual(before.rows.map(row => row.id), [3, 1, 2]);
    assert.equal((await file.textPage(0, 20)).text, original);
    const exported = join(directory, 'export.csv');
    await file.save(exported, { edits: true, sort: true, filters: true, columns: [0, 1] });
    assert.equal(await readFile(exported, 'utf8'), '\ufeffname,n\r\nB,2\r\nC,3\r\nD,4');
    assert.deepEqual(await file.page(0, 10), before);
    await file.save(exported, { edits: true, sort: false, filters: false, columns: [0] });
    assert.equal(await readFile(exported, 'utf8'), '\ufeffname\r\nA\r\nB\r\nC\r\nD');
    assert.deepEqual(await file.page(0, 10), before);
    const copy = join(directory, 'copy.csv'); await file.save(copy);
    assert.equal(await readFile(copy, 'utf8'), original); assert.equal(file.changes, 0);
    assert.deepEqual(await file.page(0, 10), before);
    assert.deepEqual(await file.pinRows([3, 0]), { rows: [3, 0], visibleRows: [3], total: 3 });
    await file.save(); assert.deepEqual((await file.page(0, 10)).pinnedRows, [3, 0]);
    assert.deepEqual(await ids(file), [3, 0, 1, 2]); assert.deepEqual(await file.locate(3), { row: 3, index: 0 });
    await file.query({ filters: [{ col: 1, type: 'number', operator: 'gte', value: 2 }], sort: { col: 1, direction: 1, numeric: true } });
    assert.deepEqual(await file.pinRows([3, 0]), { rows: [3, 0], visibleRows: [3], total: 3 });
    await file.save(undefined, { edits: true, sort: true, filters: true });
    assert.deepEqual((await file.page(0, 10)).pinnedRows, []);
    assert.equal(await readFile(path, 'utf8'), '\ufeffname,n\r\nB,2\r\nC,3\r\nD,4');
  });
});
