/*
File: Verify original coordinates, format fidelity, conflicts, and progressive reading with real files.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvFile } from '../src/engine/CsvFile';
import type { Metadata } from '../src/protocol';

async function fixture(content: string | Buffer, run: (file: CsvFile, path: string, directory: string) => Promise<void>, options: { hasHeader?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'csv-engine-'));
  const path = join(directory, 'input.csv');
  await writeFile(path, content);
  const file = new CsvFile(path, undefined, undefined, options);
  try { await file.open(); await run(file, path, directory); }
  finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
}

async function complete(file: CsvFile) {
  // Backup output waits for indexing and exercises the actual chunked save path.
  for (;;) {
    try { await file.query({ filters: [], sort: null }); return; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('being indexed')) throw error;
      await new Promise<void>(done => setImmediate(done));
    }
  }
}

test('Sorted edits target original rows and preserve BOM, CRLF, multiline fields, and untouched quoting', async () => {
  const source = '\ufeffname,note,n\r\n"乙","line1\r\nline2",2\r\n"甲","say ""hi""",1';
  await fixture(source, async (file, path) => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 2, direction: 1, numeric: true } });
    const page = await file.page(0, 10);
    assert.deepEqual(page.rows.map(row => row.id), [1, 0]);
    assert.equal((await file.edit({ row: page.rows[0].id, col: 1, value: '新,内容\n下一行' })).value, 'say "hi"');
    await file.save();
    assert.equal(await readFile(path, 'utf8'), '\ufeffname,note,n\r\n"乙","line1\r\nline2",2\r\n"甲","新,内容\n下一行",1');
  });
});

test('Undo restores original bytes while backup exports retain dirty state', async () => {
  await fixture('a,b\n"01","hello"\n', async (file, path, directory) => {
    assert.equal((await file.edit({ row: 0, col: 1, value: 'changed' })).value, 'hello');
    const backup = join(directory, 'backup.csv');
    await file.save(backup);
    assert.equal(await readFile(backup, 'utf8'), 'a,b\n"01",changed\n');
    assert.equal(await readFile(path, 'utf8'), 'a,b\n"01","hello"\n');
    assert.equal((await file.page(0, 1)).rows[0].values[1], 'changed');
    await file.edit({ row: 0, col: 1, value: 'hello' });
    await file.save();
    assert.equal(await readFile(path, 'utf8'), 'a,b\n"01","hello"\n');
  });
});

test('Dirty markers track original cells across Text edits, sorting, Save As, and overwrite', async () => {
  await fixture('name,n\na,2\nb,1\n', async (file, _path, directory) => {
    await complete(file);
    await file.edit({ row: 0, col: 0, value: 'changed' });
    await file.query({ filters: [], sort: { col: 1, direction: 1, numeric: true } });
    let page = await file.page(0, 2);
    assert.deepEqual(page.rows.map(row => [row.id, row.modified]), [[1, []], [0, [0]]]);
    await file.edit({ row: 0, col: 0, value: 'a' });
    assert.deepEqual((await file.page(0, 2)).rows.map(row => row.modified), [[], []]);
    const text = await file.textPage(0, 200);
    await file.textEdit({ ...text, text: text.text.replace('a,2', '"a",3') });
    page = await file.page(0, 2);
    assert.deepEqual(page.rows.find(row => row.id === 0)?.modified, [1]);
    await file.edit({ row: 0, col: 1, value: '2' });
    assert.deepEqual((await file.page(0, 2)).rows.find(row => row.id === 0)?.modified, []);
    await file.edit({ row: 1, col: 0, value: 'B' });
    await file.save(join(directory, 'export.csv'));
    assert.deepEqual((await file.page(0, 2)).rows.find(row => row.id === 1)?.modified, [0]);
    await file.save(); await complete(file);
    assert.deepEqual((await file.page(0, 2)).rows.map(row => row.modified), [[], []]);
  });
});

test('Ragged records preserve extra fields and reject direct edits to missing fields', async () => {
  await fixture('a,b\n1\n2,3,extra\n\n', async (file, path) => {
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.values), [['1'], ['2', '3', 'extra'], ['']]);
    await assert.rejects(file.edit({ row: 0, col: 1, value: 'x' }), /missing/);
    await file.edit({ row: 1, col: 0, value: 'changed' });
    await file.save();
    assert.equal(await readFile(path, 'utf8'), 'a,b\n1\nchanged,3,extra\n\n');
  });
});

test('External changes block saving without overwriting new disk content', async () => {
  await fixture('a,b\n1,2\n', async (file, path) => {
    await file.edit({ row: 0, col: 1, value: 'edited' });
    await writeFile(path, 'a,b\nexternal,new-content\n');
    await assert.rejects(file.save(), /changed on disk/);
    assert.equal(await readFile(path, 'utf8'), 'a,b\nexternal,new-content\n');
  });
});

test('Filters use edited values and stable sorting places empty values last', async () => {
  await fixture('a,b\nfirst,2\nsecond,\nthird,2\nfourth,1', async file => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 1, direction: -1, numeric: true } });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [0, 2, 3, 1]);
    await file.query({ filters: [{ col: 0, text: 'FIRST' }], sort: null });
    assert.equal((await file.page(0, 10)).total, 1);
    await file.edit({ row: 0, col: 0, value: 'other' });
    assert.equal((await file.page(0, 10)).total, 0);
  });
});

test('Progressive reading handles split UTF-8, quoted newlines, and complete lossless saves', async () => {
  const source = 'id,text\n' + Array.from({ length: 40000 }, (_, i) => `${i},"中文${i}\n${'x'.repeat(60)}"\r\n`).join('');
  await fixture(source, async (file, path) => {
    const first = await file.page(0, 50);
    assert.equal(first.rows.length, 50);
    assert.equal(first.rows[0].values[1], '中文0\n' + 'x'.repeat(60));
    await complete(file);
    assert.equal((await file.page(39999, 5)).rows[0].id, 39999);
    await file.edit({ row: 39999, col: 0, value: 'last' });
    await file.save();
    assert.equal(await readFile(path, 'utf8'), source.replace('39999,"中文39999', 'last,"中文39999'));
  });
});

test('Invalid UTF-8 and UTF-16 are rejected without changing source files', async () => {
  for (const content of [Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from([0x61, 0x0a, 0xc3, 0x28])]) {
    const directory = await mkdtemp(join(tmpdir(), 'csv-encoding-'));
    const path = join(directory, 'input.csv');
    await writeFile(path, content);
    const file = new CsvFile(path);
    try {
      await assert.rejects(file.open());
      assert.deepEqual(await readFile(path), content);
    } finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('Numeric sorting stably places nonnumeric and empty values last in both directions', async () => {
  await fixture('n\n2\n10\n1a\n \n-5\nInfinity\nNaN\n""', async file => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 0, direction: 1, numeric: true } });
    assert.deepEqual((await file.page(0, 20)).rows.map(row => row.id), [4, 0, 1, 2, 3, 5, 6, 7]);
    await file.query({ filters: [], sort: { col: 0, direction: -1, numeric: true } });
    assert.deepEqual((await file.page(0, 20)).rows.map(row => row.id), [1, 0, 4, 2, 3, 5, 6, 7]);
  });
});

test('Clearing a semicolon-delimited single field retains a readable record', async () => {
  await fixture('a\r\nhello', async (file, path) => {
    await file.edit({ row: 0, col: 0, value: '' });
    await file.save();
    assert.equal(await readFile(path, 'utf8'), 'a\r\n""');
    assert.deepEqual((await file.page(0, 2)).rows[0].values, ['']);
  });
  await fixture('"a;a";b\n"keep;quoted";2', async (file, path) => {
    assert.deepEqual((await file.page(0, 2)).rows[0].values, ['keep;quoted', '2']);
    await file.edit({ row: 0, col: 1, value: 'new;value' });
    await file.save();
    assert.equal(await readFile(path, 'utf8'), '"a;a";b\n"keep;quoted";"new;value"');
  });
});

test('Closing during indexing terminates scanning and releases file handles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-cancel-'));
  const path = join(directory, 'input.csv');
  await writeFile(path, 'a,b\n' + '1,2\n'.repeat(200000));
  const file = new CsvFile(path);
  try {
    await file.open();
    await file.dispose();
    await assert.rejects(file.page(0, 1), /closed/);
    await rm(path);
  } finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Invalid encoding after the first page reports a background error and blocks saving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-background-error-'));
  const path = join(directory, 'input.csv');
  await writeFile(path, Buffer.concat([Buffer.from('a,b\n' + '1,2\n'.repeat(50000)), Buffer.from([0xc3, 0x28])]));
  let report!: (error: Error) => void;
  const reported = new Promise<Error>(done => { report = done; });
  const file = new CsvFile(path, undefined, report);
  try {
    await file.open();
    assert.match((await reported).message, /UTF-8/);
    await assert.rejects(file.save(), /UTF-8/);
  } finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Opening and reindexing after saving report a new scan start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-reset-'));
  const path = join(directory, 'input.csv');
  await writeFile(path, 'a,b\n1,2');
  const events: Metadata[] = [];
  const file = new CsvFile(path, metadata => events.push(metadata));
  try {
    await file.open();
    assert.equal(events[0].scanned, 0);
    assert.equal(events[0].complete, false);
    assert.deepEqual(events[0].headers, []);
    events.length = 0;
    await file.edit({ row: 0, col: 1, value: '3' });
    await file.save();
    assert.equal(events[0].scanned, 0);
    assert.equal(events[0].complete, false);
    assert.deepEqual(events[0].headers, []);
  } finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Headerless saves and backups preserve first and last records, BOM, and original row order', async () => {
  const source = '\ufeff"first",2\r\n"last",1';
  await fixture(source, async (file, path, directory) => {
    await complete(file);
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.values), [['first', '2'], ['last', '1']]);
    await file.query({ filters: [], sort: { col: 1, direction: 1, numeric: true } });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [1, 0]);
    await file.edit({ row: 0, col: 0, value: 'changed,first' });
    await file.edit({ row: 1, col: 1, value: '3' });
    const backup = join(directory, 'backup.csv');
    await file.save(backup);
    assert.equal(await readFile(path, 'utf8'), source);
    const saved = '\ufeff"changed,first",2\r\n"last",3';
    assert.equal(await readFile(backup, 'utf8'), saved);
    const metadata = await file.save();
    assert.equal(metadata?.hasHeader, false);
    assert.deepEqual(metadata?.headers, ['A', 'B']);
    assert.equal(await readFile(path, 'utf8'), saved);
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.values), [['changed,first', '2'], ['last', '3']]);
  }, { hasHeader: false });
});

test('Headerless names extend beyond Z and toggling headers preserves file records', async () => {
  const source = 'first,2\n' + Array.from({ length: 28 }, (_, col) => String(col)).join(',');
  await fixture(source, async (file, path) => {
    const metadata = await file.reload();
    assert.equal(metadata.headers.length, 28);
    assert.deepEqual(metadata.headers.slice(25), ['Z', 'AA', 'AB']);
    assert.equal((await file.page(0, 10)).total, 2);
    await file.dispose();
    const withHeader = new CsvFile(path);
    try {
      const header = await withHeader.open();
      assert.deepEqual(header.headers, ['first', '2']);
      assert.equal((await withHeader.page(0, 10)).total, 1);
      assert.equal(await readFile(path, 'utf8'), source);
    } finally { await withHeader.dispose(); }
  }, { hasHeader: false });
});

test('Copy follows filtered sorted column order and preserves edits, tabs, quotes, and newlines', async () => {
  await fixture('name,note,n\nfirst,"a\tb",2\nsecond,"say ""hi""\nnext",1\nthird,exclude,3', async file => {
    await complete(file);
    await file.query({ filters: [{ col: 0, text: 's' }], sort: { col: 2, direction: 1, numeric: true } });
    await file.edit({ row: 0, col: 0, value: 'first edited' });
    assert.equal(await file.copy(0, 2, [1, 0]), '"say ""hi""\nnext"\tsecond\n"a\tb"\tfirst edited');
    assert.equal(await file.copy(0, 1, [1]), 'say "hi"\nnext');
    await assert.rejects(file.copy(0, 3, [0]), /Selection/);
    await assert.rejects(file.copy(0, 1, [3]), /Selection/);
    await assert.rejects(file.copy(0, 1, Array(100001).fill(0)), /100,000/);
  });
});

test('Copy rejects the complete result beyond its byte budget and permits later small selections', async () => {
  const value = '中'.repeat(3 * 1024 * 1024);
  await fixture(`a,b\n${value},small`, async file => {
    await assert.rejects(file.copy(0, 1, [0]), /8 MB/);
    assert.equal(await file.copy(0, 1, [1]), 'small');
  });
});

test('Automatic sorting infers type from the entire column and reclassifies edited values', async () => {
  await fixture('n,group\n2,keep\n10,keep\n ,skip\n-1,keep', async file => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 0, direction: 1, numeric: 'auto' } });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [3, 0, 1, 2]);
    await file.edit({ row: 2, col: 0, value: 'text' });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [3, 1, 0, 2]);
    await file.query({ filters: [{ col: 1, type: 'text', text: 'keep' }], sort: { col: 0, direction: 1, numeric: 'auto' } });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [3, 1, 0]);
    await file.edit({ row: 2, col: 0, value: '.5e1' });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [3, 0, 1]);
    await file.query({ filters: [], sort: { col: 0, direction: 1, numeric: false } });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [3, 2, 1, 0]);
  });
});

test('Numeric comparisons and inclusive ranges share decimal semantics and exclude text and blanks', async () => {
  await fixture('n\n-2\n+.5\n1e1\n10\n0x10\nNaN\n \n""\n11', async file => {
    await complete(file);
    const expected = { eq: [2, 3], ne: [0, 1, 8], gt: [8], gte: [2, 3, 8], lt: [0, 1], lte: [0, 1, 2, 3], between: [2, 3, 8] };
    for (const operator of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'] as const) {
      await file.query({ filters: [{ col: 0, type: 'number', operator, value: 10, max: 11 }], sort: null });
      assert.deepEqual((await file.page(0, 20)).rows.map(row => row.id), expected[operator]);
    }
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'number', operator: 'between', value: 11, max: 10 }], sort: null }), /Invalid/);
    assert.deepEqual((await file.page(0, 20)).rows.map(row => row.id), [2, 3, 8]);
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'number', operator: 'gt', value: NaN }], sort: null }), /Invalid/);
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'number', operator: 'between', value: 0 }], sort: null }), /Invalid/);
    assert.deepEqual((await file.page(0, 20)).rows.map(row => row.id), [2, 3, 8]);
  });
});

test('Empty filters include whitespace and missing fields and combine with text filters and edits', async () => {
  await fixture('name,n\nalpha,\nbeta, \nGamma\ndelta,0\nepsilon,text', async file => {
    await complete(file);
    await file.query({ filters: [{ col: 1, type: 'empty' }], sort: null });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [0, 1, 2]);
    await file.query({ filters: [{ col: 1, type: 'notEmpty' }, { col: 0, type: 'text', text: 'DEL' }], sort: null });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [3]);
    await file.edit({ row: 3, col: 1, value: ' ' });
    assert.equal((await file.page(0, 10)).total, 0);
  });
});

test('Selection statistics follow view coordinates and edited values with compensated summation', async () => {
  await fixture('n,other\n10,1\n2,text\n-3, \n4,5', async file => {
    await complete(file);
    await file.query({ filters: [{ col: 0, type: 'number', operator: 'gte', value: 0 }], sort: { col: 0, direction: 1, numeric: 'auto' } });
    assert.deepEqual(await file.stats(0, 2, [1, 0]), { count: 4, numericCount: 3, nonEmptyCount: 4, min: 2, max: 5, sum: 11, average: 11 / 3 });
    await file.edit({ row: 1, col: 1, value: '3' });
    assert.deepEqual(await file.stats(0, 2, [1, 0]), { count: 4, numericCount: 4, nonEmptyCount: 4, min: 2, max: 5, sum: 14, average: 3.5 });
    await assert.rejects(file.stats(0, 4, [0]), /Selection/);
    await assert.rejects(file.stats(0, 1, []), /Selection/);
    await assert.rejects(file.stats(0, 1, [2]), /Selection/);
  });
  await fixture('n\n1e16\n1\n-1e16\n0x10\n""', async file => {
    assert.deepEqual(await file.stats(0, 5, [0]), { count: 5, numericCount: 3, nonEmptyCount: 4, min: -1e16, max: 1e16, sum: 1, average: 1 / 3 });
    assert.deepEqual(await file.stats(3, 2, [0]), { count: 2, numericCount: 0, nonEmptyCount: 1, min: null, max: null, sum: 0, average: null });
  });
  await fixture('n\n1e308\n1e308', async file => {
    await assert.rejects(file.stats(0, 2, [0]), /numeric range/);
    assert.equal((await file.stats(0, 1, [0])).sum, 1e308);
  });
});

test('Large selection statistics avoid clipboard count limits and cell result collections', async () => {
  await fixture('n\n' + '1\n'.repeat(100001), async file => {
    await complete(file);
    assert.deepEqual(await file.stats(0, 100001, [0]), { count: 100001, numericCount: 100001, nonEmptyCount: 100001, min: 1, max: 1, sum: 100001, average: 1 });
  });
});

test('Disjoint copy and statistics follow queried coordinates and include only selected edited cells', async () => {
  await fixture('name,n,m\nfirst,40,4\nsecond,10,1\nthird,30,3\nfourth,20,2\nexcluded,-1,99', async file => {
    await complete(file);
    await file.query({ filters: [{ col: 1, type: 'number', operator: 'gt', value: 0 }], sort: { col: 1, direction: 1, numeric: true } });
    await file.edit({ row: 0, col: 2, value: '5' });
    const ranges = [{ start: 0, count: 1 }, { start: 2, count: 2 }];
    assert.equal(await file.copy(0, 4, [2, 0], ranges), '1\tsecond\n3\tthird\n5\tfirst');
    assert.deepEqual(await file.stats(0, 4, [2, 0], ranges), { count: 6, numericCount: 3, nonEmptyCount: 6, min: 1, max: 5, sum: 9, average: 3 });
    assert.deepEqual(await file.stats(0, 4, [2, 1], ranges), { count: 6, numericCount: 6, nonEmptyCount: 6, min: 1, max: 40, sum: 89, average: 89 / 6 });
    for (const malformed of [[], [{ start: 1, count: 3 }], [{ start: 0, count: 2 }, { start: 1, count: 3 }], [{ start: 2, count: 2 }, { start: 0, count: 1 }], [{ start: 0, count: 1 }, { start: 2, count: 0 }], [{ start: 0, count: 1 }, { start: 2, count: 1 }], [{ start: 0, count: 1 }, { start: 3, count: 2 }], [{ start: 0, count: 1 }, { start: 2.5, count: 1.5 }]]) {
      await assert.rejects(file.copy(0, 4, [0], malformed), /Selection/);
      await assert.rejects(file.stats(0, 4, [0], malformed), /Selection/);
    }
  });
});

test('Sparse row copy limits count actual selected cells', async () => {
  await fixture('n\n' + '1\n'.repeat(100001), async file => {
    await complete(file);
    const ranges = [{ start: 0, count: 1 }, { start: 100000, count: 1 }];
    assert.equal(await file.copy(0, 100001, [0], ranges), '1\n1');
    assert.deepEqual(await file.stats(0, 100001, [0], ranges), { count: 2, numericCount: 2, nonEmptyCount: 2, min: 1, max: 1, sum: 2, average: 1 });
  });
});

test('Reverse queries preserve multiline fields across read blocks and long records during statistics and saving', async () => {
  const block = 1024 * 1024;
  const rows = Array.from({ length: 50 }, (_, index) => ({ n: index + 1, note: `中文${index}\n` + 'x'.repeat(index === 25 ? block + 100 : 45000) }));
  const source = '\ufeffn,note\r\n' + rows.map(row => `${row.n},"${row.note}"\r\n`).join('');
  await fixture(source, async (file, path) => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 0, direction: -1, numeric: 'auto' } });
    const page = await file.page(0, 50);
    assert.deepEqual(page.rows.map(row => row.values), [...rows].reverse().map(row => [String(row.n), row.note]));
    assert.deepEqual(await file.stats(0, 50, [0]), { count: 50, numericCount: 50, nonEmptyCount: 50, min: 1, max: 50, sum: 1275, average: 25.5 });
    await file.query({ filters: [], sort: { col: 1, direction: 1, numeric: false } });
    const shuffled = [...rows].sort((left, right) => left.note < right.note ? -1 : 1);
    assert.deepEqual((await file.page(0, 50)).rows.map(row => row.values), shuffled.map(row => [String(row.n), row.note]));
    assert.equal((await file.stats(0, 50, [0])).sum, 1275);
    await file.edit({ row: 24, col: 1, value: 'changed\n中文' });
    await file.save();
    assert.equal(await readFile(path, 'utf8'), source.replace(`"${rows[24].note}"`, '"changed\n中文"'));
  });
});

test('Save independently controls edits, sorting, and filtering while Save As preserves current dirty state', async () => {
  await fixture('\ufeffname,n\r\nkeep,30\r\n"drop",10\r\nkeep,20', async (file, path, directory) => {
    await complete(file);
    await file.edit({ row: 0, col: 1, value: '40' });
    await file.query({ filters: [{ col: 0, text: 'keep' }], sort: { col: 1, direction: 1, numeric: 'auto' } });
    const cases = [
      { edits: true, sort: false, filters: false, expected: '\ufeffname,n\r\nkeep,40\r\n"drop",10\r\nkeep,20' },
      { edits: false, sort: true, filters: false, expected: '\ufeffname,n\r\n"drop",10\r\nkeep,20\r\nkeep,30' },
      { edits: true, sort: false, filters: true, expected: '\ufeffname,n\r\nkeep,40\r\nkeep,20' },
      { edits: true, sort: true, filters: true, expected: '\ufeffname,n\r\nkeep,20\r\nkeep,40' },
    ];
    for (const item of cases) {
      const target = join(directory, 'export.csv');
      await file.save(target, item);
      assert.equal(await readFile(target, 'utf8'), item.expected);
      assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [2, 0]);
    }
    assert.equal(await readFile(path, 'utf8'), '\ufeffname,n\r\nkeep,30\r\n"drop",10\r\nkeep,20');
    await file.save(undefined, { edits: true, sort: true, filters: true });
    await complete(file);
    assert.equal(await readFile(path, 'utf8'), '\ufeffname,n\r\nkeep,20\r\nkeep,40');
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.values), [['keep', '20'], ['keep', '40']]);
  });
});

test('Headerless sorted exports preserve BOM and multiline boundaries while empty filters retain headers', async () => {
  await fixture('\ufeffz,"line1\nline2"\na,last', async (file, path) => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 0, direction: 1, numeric: false } });
    await file.save(undefined, { edits: true, sort: true, filters: false });
    assert.equal(await readFile(path, 'utf8'), '\ufeffa,last\nz,"line1\nline2"');
  }, { hasHeader: false });
  await fixture('name,n\nkeep,1\n', async (file, path) => {
    await complete(file);
    await file.query({ filters: [{ col: 0, text: 'absent' }], sort: null });
    await file.save(undefined, { edits: true, sort: false, filters: true });
    assert.equal(await readFile(path, 'utf8'), 'name,n\n');
  });
});

test('Headerless empty records remain readable when moved to the end', async () => {
  await fixture('\ufeffb\n\nz', async (file, path) => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 0, direction: 1, numeric: false } });
    await file.save(undefined, { edits: true, sort: true, filters: false });
    await complete(file);
    assert.equal(await readFile(path, 'utf8'), '\ufeffb\nz\n""');
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.values[0]), ['b', 'z', '']);
  }, { hasHeader: false });
});

test('Text edits preserve original order and CSV format and share saving with cell edits', async () => {
  const source = '\ufeffname,note,n\r\n"乙","line1\r\nline2",2\r\n"甲","say ""hi""",1';
  await fixture(source, async (file, path, directory) => {
    await complete(file);
    await file.query({ filters: [], sort: { col: 2, direction: 1, numeric: true } });
    const initial = await file.textPage(0, 200);
    assert.equal(initial.text, source);
    const edited = source.replace('line2', 'next,part').replace(',2\r\n', ',0\r\n');
    const result = await file.textEdit({ ...initial, text: edited });
    assert.equal(result.error, undefined);
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [0, 1]);
    await assert.rejects(file.textEdit({ ...initial, text: source }), /changed/);
    await file.edit({ row: 0, col: 2, value: '3' });
    assert.equal((await file.textPage(0, 200)).text, edited.replace(',0\r\n', ',3\r\n'));
    const exported = join(directory, 'original.csv');
    await file.save(exported, { edits: false, sort: false, filters: false });
    assert.equal(await readFile(exported, 'utf8'), source);
    await file.save();
    assert.equal(await readFile(path, 'utf8'), edited.replace(',0\r\n', ',3\r\n'));
  });
});

test('Invalid Text cannot be committed and bounded segments preserve adjacent record boundaries', async () => {
  await fixture('a,b\n' + 'x'.repeat(600000) + ',1\n' + 'y'.repeat(600000) + ',2\nlast,3\n', async (file, path) => {
    await complete(file);
    const initial = await file.textPage(0, 200);
    assert.equal(initial.count, 2);
    assert.ok(Buffer.byteLength(initial.text) <= 1024 * 1024);
    const invalid = await file.textEdit({ ...initial, text: initial.text.slice(0, -1) });
    assert.match(invalid.error!, /line break/);
    const quote = await file.textEdit({ ...initial, text: 'a,b\n"unterminated' });
    assert.ok(quote.error);
    assert.equal((await file.textPage(0, 200)).text, initial.text);
    const next = await file.textPage(initial.count, 200);
    assert.equal(next.count, 2);
    const changed = await file.textEdit({ ...next, text: next.text.replace('last,3', 'last,4') });
    assert.equal(changed.error, undefined);
    await file.save();
    assert.ok((await readFile(path, 'utf8')).endsWith('last,4\n'));
  });
});
