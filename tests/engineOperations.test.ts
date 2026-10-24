/*
Purpose: Verify data integrity for full-file search/replacement, rectangular paste, structural transactions, undo, and encoding.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { CsvFile } from '../src/engine/CsvFile';
import type { ChangeOperation, FileFormat } from '../src/protocol';

async function fixture(content: string | Buffer, run: (file: CsvFile, path: string, directory: string) => Promise<void>, options: { hasHeader?: boolean; format?: FileFormat } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'csv-operations-test-')), path = join(directory, 'input.csv');
  await writeFile(path, content);
  const file = new CsvFile(path, undefined, undefined, options);
  try { await file.open(); await run(file, path, directory); }
  finally { await file.dispose(); await rm(directory, { recursive: true, force: true }); }
}
const values = async (file: CsvFile) => (await file.page(0, 500)).rows.map(row => row.values);

test('Selection search maps sorted view rows and exact sparse points without matching their cross cells', async () => {
  await fixture('A,B,rank\nsame,same,3\nsame,same,1\nsame,same,2', async file => {
    await file.query({ filters: [], sort: { col: 2, direction: 1, numeric: true } });
    const selection = { start: 0, count: 3, columns: [0, 1], cells: [{ row: 0, col: 0 }, { row: 2, col: 1 }] };
    const result = await file.search({ text: 'same', selection });
    assert.equal(result.total, 2);
    assert.deepEqual(result.matches.map(({ row, col }) => [row, col]), [[0, 1], [1, 0]]);
    assert.equal((await file.search({ text: 'same', selection, columns: [1] })).total, 1);
    const page = await file.search({ text: 'same', selection, limit: 1 });
    assert.equal(page.truncated, true);
    assert.deepEqual((await file.search({ text: 'same', selection, after: { row: 0, col: 1 } })).matches.map(({ row, col }) => [row, col]), [[1, 0]]);
    assert.equal((await file.search({ text: 'same', selection: { start: 0, count: 3, columns: [0, 1], ranges: [{ start: 0, count: 1 }, { start: 2, count: 1 }] } })).total, 4);
    assert.equal((await file.search({ text: 'same' })).total, 6);
    await assert.rejects(file.search({ text: 'same', selection: { ...selection, cells: [{ row: 3, col: 0 }] } }));
  });
});

test('Full-file search bounds results, supports case/column/regex/continuation, and includes filtered-out matches', async () => {
  await fixture('name,n\nAlpha,2\nalpha,3\nBeta,2\nALPHA,4', async file => {
    assert.equal((await file.search({ text: 'alpha' })).total, 3);
    assert.equal((await file.search({ text: 'alpha', caseSensitive: true })).total, 1);
    assert.equal((await file.search({ text: '^2$', regex: true, columns: [1] })).total, 2);
    const first = await file.search({ text: 'alpha', limit: 2 });
    assert.deepEqual(first.matches.map(match => match.row), [0, 1]); assert.equal(first.truncated, true);
    const last = await file.search({ text: 'alpha', limit: 2, after: { row: 1, col: 0 } });
    assert.deepEqual(last.matches.map(match => match.row), [3]); assert.equal(last.truncated, false);
    await file.query({ filters: [{ col: 0, text: 'beta' }], sort: null });
    assert.equal((await file.search({ text: 'alpha' })).total, 3);
    assert.deepEqual(await file.locate(0), { row: 0, index: null });
    assert.deepEqual(await file.locate(2), { row: 2, index: 0 });
    await assert.rejects(file.search({ text: '(a)\\1', regex: true }));
  });
});

test('Replacement supports whole files and filtered sparse selections, regex groups, and literal dollar signs', async () => {
  const source = 'name,n\nalpha1,3\nalpha2,2\nalpha3,1';
  await fixture(source, async (file, path) => {
    await file.search({ text: 'alpha' });
    await file.query({ filters: [], sort: { col: 1, direction: 1, numeric: true } });
    const result = await file.change({ kind: 'replace', search: { text: '(alpha)([13])', regex: true }, replacement: '$2-$1', selection: { start: 0, count: 3, columns: [0], ranges: [{ start: 0, count: 1 }, { start: 2, count: 1 }] } });
    assert.deepEqual(await values(file), [['3-alpha', '1'], ['alpha2', '2'], ['1-alpha', '3']]);
    assert.equal(await readFile(path, 'utf8'), source);
    await file.restore(result.before); assert.deepEqual(await values(file), [['alpha1', '3'], ['alpha2', '2'], ['alpha3', '1']]);
    await file.restore(result.after);
    await file.change({ kind: 'replace', search: { text: 'alpha' }, replacement: '$&' });
    assert.deepEqual(await values(file), [['1-$&', '3'], ['$&2', '2'], ['3-$&', '1']]);
  });
});

test('Paste maps visual coordinates, preserves quoted multiline TSV, appends rows, and undoes atomically', async () => {
  await fixture('a,b\nA,2\nB,1', async (file, path, directory) => {
    await file.search({ text: 'A' });
    await file.query({ filters: [], sort: { col: 1, direction: 1, numeric: true } });
    const pasted = await file.change({ kind: 'paste', row: 0, columns: [1, 0], text: '10\t"hello\nworld"\n20\t"tab\tvalue"' });
    await file.query({ filters: [], sort: null });
    assert.deepEqual(await values(file), [['tab\tvalue', '20'], ['hello\nworld', '10']]);
    const target = join(directory, 'copy.csv'); await file.save(target);
    assert.equal(await readFile(path, 'utf8'), 'a,b\nA,2\nB,1');
    await file.restore(pasted.before); assert.deepEqual(await values(file), [['A', '2'], ['B', '1']]);
    await file.restore(pasted.after);
    await file.change({ kind: 'paste', row: 1, columns: [0, 1], text: 'C\t3\nD\t4' });
    assert.deepEqual(await values(file), [['tab\tvalue', '20'], ['C', '3'], ['D', '4']]);
    const before = await values(file);
    await assert.rejects(file.change({ kind: 'paste', row: 0, columns: [0], text: '1\t2' }), /columns/);
    assert.deepEqual(await values(file), before);
  });
});

test('Consecutive structural transactions retain snapshots, preserve the source, export original data without edits, and clear history on overwrite', async () => {
  const source = '\ufeffname,n\r\nA,1\r\nB,2';
  await fixture(source, async (file, path, directory) => {
    const rows = await file.change({ kind: 'insertRows', at: 1, count: 2 });
    assert.equal(rows.metadata.rows, 4);
    const column = await file.change({ kind: 'insertColumn', at: 1, name: 'note' });
    assert.deepEqual(column.metadata.headers, ['name', 'note', 'n']);
    await file.change({ kind: 'cells', edits: [{ row: 1, col: 1, value: 'new\nvalue' }] });
    await file.change({ kind: 'deleteRows', rows: [2] });
    await file.change({ kind: 'deleteColumns', columns: [2] });
    assert.deepEqual(await values(file), [['A', ''], ['', 'new\nvalue'], ['B', '']]);
    const original = join(directory, 'original.csv');
    await file.save(original, { edits: false, sort: false, filters: false }); assert.equal(await readFile(original, 'utf8'), source);
    await assert.rejects(file.save(original, { edits: false, sort: true, filters: false }), /together/);
    await file.restore(column.before); assert.deepEqual(await values(file), [['A', '1'], ['', ''], ['', ''], ['B', '2']]);
    await file.restore(rows.before); assert.deepEqual(await values(file), [['A', '1'], ['B', '2']]);
    await file.restore(column.after); assert.equal((await file.page(0, 10)).rows.length, 4);
    assert.equal(await readFile(path, 'utf8'), source);
    await file.save(); assert.equal(file.changes, 0);
    await assert.rejects(file.restore(rows.before), /no longer/);
  });
});

test('Batch restoration clears markers and restores original quoting while fill can populate missing fields', async () => {
  const source = 'a,b\n"A",1\nB';
  await fixture(source, async (file, path) => {
    await file.change({ kind: 'fill', selection: { start: 0, count: 1, columns: [0] }, value: 'changed' });
    assert.deepEqual((await file.page(0, 1)).rows[0].modified, [0]);
    await file.change({ kind: 'fill', selection: { start: 0, count: 1, columns: [0] }, value: 'A' });
    assert.equal(file.changes, 0); assert.deepEqual((await file.page(0, 1)).rows[0].modified, []);
    await file.save(); assert.equal(await readFile(path, 'utf8'), source);
    await file.change({ kind: 'fill', selection: { start: 1, count: 1, columns: [1] }, value: 'fixed' });
    assert.deepEqual(await values(file), [['A', '1'], ['B', 'fixed']]);
  });
});

test('Moving rows preserves raw CSV fields and source bytes, updates source IDs, and restores in one transaction', async () => {
  const source = '\ufeffname,n\r\n"A",1\r\n"B\nline",2\r\nC,3';
  await fixture(source, async (file, path, directory) => {
    const moved = await file.change({ kind: 'moveRow', row: 2, before: 0 });
    assert.deepEqual(await values(file), [['C', '3'], ['A', '1'], ['B\nline', '2']]);
    assert.deepEqual((await file.page(0, 3)).rows.map(row => row.id), [0, 1, 2]);
    const target = join(directory, 'moved.csv'); await file.save(target);
    assert.equal(await readFile(target, 'utf8'), '\ufeffname,n\r\nC,3\r\n"A",1\r\n"B\nline",2');
    assert.equal(await readFile(path, 'utf8'), source);
    await file.restore(moved.before); assert.equal(file.changes, 0);
    assert.deepEqual(await values(file), [['A', '1'], ['B\nline', '2'], ['C', '3']]);
    await file.restore(moved.after);
    await file.edit({ row: 0, col: 0, value: 'edited' });
    await file.change({ kind: 'moveRow', row: 0, before: 3 });
    assert.deepEqual(await values(file), [['A', '1'], ['B\nline', '2'], ['edited', '3']]);
    await file.save();
    assert.equal(await readFile(path, 'utf8'), '\ufeffname,n\r\n"A",1\r\n"B\nline",2\r\nedited,3');
  });
});

test('Moving columns preserves raw field bytes, headers and line endings, maps dirty markers, and restores atomically', async () => {
  const source = '\ufeff"a",b,c\r\n" A ","line1\nline2","quote""x"\nZ,Q,R';
  await fixture(source, async (file, path, directory) => {
    await file.query({ filters: [{ col: 0, text: ' A ' }], sort: { col: 2, direction: 1, numeric: false } });
    const moved = await file.change({ kind: 'moveColumn', col: 0, before: 3 });
    assert.deepEqual(moved.metadata.headers, ['b', 'c', 'a']);
    assert.deepEqual(await values(file), [['line1\nline2', 'quote"x', ' A '], ['Q', 'R', 'Z']]);
    const target = join(directory, 'columns.csv'); await file.save(target);
    assert.equal(await readFile(target, 'utf8'), '\ufeffb,c,"a"\r\n"line1\nline2","quote""x"," A "\nQ,R,Z');
    assert.equal(await readFile(path, 'utf8'), source);
    await file.restore(moved.before); assert.deepEqual((await file.page(0, 1)).rows[0].values, [' A ', 'line1\nline2', 'quote"x']); assert.equal(file.changes, 0);
    await file.edit({ row: 0, col: 1, value: 'edited,\n"value"' });
    const dirty = await file.change({ kind: 'moveColumn', col: 0, before: 3 });
    assert.deepEqual((await file.page(0, 1)).rows[0].modified, [0]);
    assert.equal((await file.page(0, 1)).rows[0].values[0], 'edited,\n"value"');
    await file.restore(dirty.before); assert.deepEqual((await file.page(0, 1)).rows[0].modified, [1]);
    await file.restore(dirty.after); assert.deepEqual((await file.page(0, 1)).rows[0].modified, [0]);
    await file.save(); assert.deepEqual((await file.page(0, 1)).rows[0].modified, []);
    assert.equal(await readFile(path, 'utf8'), '\ufeffb,c,"a"\r\n"edited,\n""value""","quote""x"," A "\nQ,R,Z');
  });
});

test('Column moves pad missing fields, retain extra fields, preserve headerless BOM, and reject invalid coordinates', async () => {
  await fixture('a,b,c\nA\nB,C,D,extra', async (file, path) => {
    await file.change({ kind: 'moveColumn', col: 0, before: 3 }); await file.save();
    assert.equal(await readFile(path, 'utf8'), 'b,c,a\n,,A\nC,D,B,extra');
  });
  await fixture('\ufeffA,1\r\n"B",2,C\nD', async (file, path) => {
    const moved = await file.change({ kind: 'moveColumn', col: 2, before: 0 });
    assert.deepEqual(await values(file), [['', 'A', '1'], ['C', 'B', '2'], ['', 'D', '']]);
    await file.restore(moved.before); assert.deepEqual(await values(file), [['A', '1'], ['B', '2', 'C'], ['D']]);
    await file.restore(moved.after); await file.save();
    assert.equal(await readFile(path, 'utf8'), '\ufeff,A,1\r\nC,"B",2\n,D,');
    for (const [col, before] of [[-1, 0], [3, 0], [1, 4], [0.5, 2], [0, NaN]]) await assert.rejects(file.change({ kind: 'moveColumn', col, before }), /valid column/);
    for (const before of [1, 2]) { const unchanged = await file.change({ kind: 'moveColumn', col: 1, before }); assert.equal(unchanged.before, unchanged.after); assert.equal(unchanged.changes, 0); }
    await file.change({ kind: 'moveColumn', col: 0, before: 2 });
    assert.deepEqual((await file.page(0, 1)).rows[0].values, ['A', '', '1']);
  }, { hasHeader: false });
});

test('Export projects visible source columns with current edits, filters and sorting while preserving document state and source', async () => {
  const source = 'a,b,c\r\n"A",2,x\r\nB,1,y\r\nC,3,z';
  await fixture(source, async (file, path, directory) => {
    const move = await file.change({ kind: 'moveColumn', col: 0, before: 3 });
    await file.edit({ row: 0, col: 0, value: '4' });
    await file.query({ filters: [{ col: 0, type: 'number', operator: 'gte', value: 2 }], sort: { col: 0, direction: -1, numeric: true } });
    const before = await file.page(0, 10), changes = file.changes;
    const target = join(directory, 'visible.csv'), options = { edits: true, sort: true, filters: true, columns: [2, 0] };
    assert.equal(await file.save(target, options), null);
    assert.equal(await readFile(target, 'utf8'), 'b,a\r\n4,"A"\r\n3,C');
    assert.equal(await readFile(path, 'utf8'), source);
    assert.deepEqual(await file.page(0, 10), before); assert.equal(file.changes, changes);
    await assert.rejects(file.save(path, options), /different file/);
    await assert.rejects(file.save(undefined, options), /different file/);
    for (const columns of [[], [0, 0], [3]]) await assert.rejects(file.save(target, { ...options, columns }), /valid columns/);
    assert.equal(await readFile(target, 'utf8'), 'b,a\r\n4,"A"\r\n3,C');
    await file.restore(move.before); assert.equal(file.changes, 0);
    assert.deepEqual(await values(file), [['A', '2', 'x'], ['B', '1', 'y'], ['C', '3', 'z']]);
    const alias = join(directory, 'alias.csv'); await link(path, alias);
    await assert.rejects(file.save(alias, options), /different file/);
  });
  await fixture('\ufeffA,1\r\n,2', async (file, path, directory) => {
    const target = join(directory, 'one.csv'); await file.save(target, { edits: true, sort: true, filters: true, columns: [0] });
    assert.equal(await readFile(target, 'utf8'), '\ufeffA\r\n""');
    assert.equal(await readFile(path, 'utf8'), '\ufeffA,1\r\n,2');
  }, { hasHeader: false });
});

test('Legacy export without edits reads original bytes independently of structural query coordinates', async () => {
  const source = 'a,b\nA,1\nB,2';
  await fixture(source, async (file, path, directory) => {
    await file.change({ kind: 'moveColumn', col: 0, before: 2 });
    await file.change({ kind: 'insertColumn', at: 2, name: 'new' });
    await file.query({ filters: [{ col: 2, type: 'empty' }], sort: { col: 2, direction: 1, numeric: false } });
    const target = join(directory, 'original.csv');
    await file.save(target, { edits: false, sort: false, filters: false });
    assert.equal(await readFile(target, 'utf8'), source);
    for (const options of [{ edits: false, sort: true, filters: false }, { edits: false, sort: false, filters: true }, { edits: false, sort: false, filters: false, columns: [2] }]) await assert.rejects(file.save(target, options), /together/);
    assert.equal(await readFile(path, 'utf8'), source);
    assert.equal(await readFile(target, 'utf8'), source);
  });
});


test('Moving rows enforces source coordinates, rejects query views, and treats neighboring drops as no change', async () => {
  await fixture('name,n\nA,1\nB,2\nC,3\n', async file => {
    await file.query({ filters: [], sort: { col: 1, direction: -1, numeric: true } });
    await assert.rejects(file.change({ kind: 'moveRow', row: 0, before: 3 }), /Clear sorting and filters/);
    await file.query({ filters: [{ col: 0, text: 'A' }], sort: null });
    await assert.rejects(file.change({ kind: 'moveRow', row: 0, before: 3 }), /Clear sorting and filters/);
    await file.query({ filters: [], sort: null });
    for (const [row, before] of [[-1, 0], [3, 0], [1, 4], [0.5, 2], [0, NaN]]) await assert.rejects(file.change({ kind: 'moveRow', row, before }), /valid row/);
    for (const before of [1, 2]) {
      const result = await file.change({ kind: 'moveRow', row: 1, before });
      assert.equal(result.before, result.after); assert.equal(result.changes, 0);
    }
    await file.change({ kind: 'moveRow', row: 0, before: 2 });
    assert.deepEqual(await values(file), [['B', '2'], ['A', '1'], ['C', '3']]);
  });
  await fixture('\ufeff"A",1\r\nB,2\r\nC,3', async (file, path) => {
    await file.change({ kind: 'moveRow', row: 0, before: 3 }); await file.save();
    assert.equal(await readFile(path, 'utf8'), '\ufeffB,2\r\nC,3\r\n"A",1');
  }, { hasHeader: false });
});

test('Headerless BOM stays at the file start through row and column changes with final newline conventions preserved', async () => {
  const operations: ChangeOperation[] = [
    { kind: 'insertRows', at: 0, count: 1 }, { kind: 'deleteRows', rows: [0] },
    { kind: 'insertColumn', at: 1, name: 'unused' }, { kind: 'deleteColumns', columns: [0] },
  ];
  for (const operation of operations) await fixture('\ufeffA,1\r\nB,2', async (file, path) => {
    await file.change(operation); await file.save();
    const text = await readFile(path, 'utf8');
    assert.equal(text.startsWith('\ufeff'), true, operation.kind);
    assert.equal(text.indexOf('\ufeff', 1), -1, operation.kind);
    assert.equal(/[\r\n]$/.test(text), false, operation.kind);
    assert.equal((await file.page(0, 10)).rows.some(row => row.values.some(value => value.includes('\ufeff'))), false);
  }, { hasHeader: false });
});

test('Full-file checks report duplicate combinations, missing fields, and ragged rows with bounded results', async () => {
  await fixture('a,b\nX,1\nX,1\nX,2\n ,\nZ\nQ,3,extra', async file => {
    assert.equal((await file.check({ kind: 'duplicates' })).total, 1);
    assert.equal((await file.check({ kind: 'duplicates', columns: [0], limit: 1 })).total, 2);
    assert.equal((await file.check({ kind: 'duplicates', columns: [0], limit: 1 })).truncated, true);
    assert.equal((await file.check({ kind: 'missing' })).total, 3);
    assert.deepEqual((await file.check({ kind: 'ragged' })).issues.map(issue => issue.row), [4, 5]);
  });
});

test('GBK and UTF16 stream indexing and saving, reject unrepresentable output, and permit UTF8 export', async () => {
  for (const encoding of ['gbk', 'utf16le']) {
    const source = `${encoding === 'utf16le' ? '\ufeff' : ''}产品;备注\r\n苹果;中文\r\n梨子;第二行`;
    await fixture(iconv.encode(source, encoding), async (file, path, directory) => {
      assert.deepEqual(await values(file), [['苹果', '中文'], ['梨子', '第二行']]);
      await file.change({ kind: 'cells', edits: [{ row: 0, col: 1, value: '更新' }] });
      await file.save(); assert.equal(iconv.decode(await readFile(path), encoding), source.replace(/^\ufeff/, '').replace('中文', '更新'));
      if (encoding === 'gbk') {
        await file.edit({ row: 0, col: 1, value: 'emoji😀' });
        const before = await readFile(path);
        await assert.rejects(file.save(), /cannot be saved/); assert.deepEqual(await readFile(path), before);
        await file.save(join(directory, 'utf8.csv'), { edits: true, sort: false, filters: false, encoding: 'utf8' });
        assert.equal((await readFile(join(directory, 'utf8.csv'), 'utf8')).includes('emoji😀'), true);
        await file.save(undefined, { edits: true, sort: false, filters: false, encoding: 'utf8' });
        assert.equal((await file.textPage(0, 3)).text.includes('emoji😀'), true);
      }
    }, { format: { encoding, delimiter: ';' } });
  }
});

test('Linear regex handles adversarial input and oversized replacements roll back without losing source or edits', async () => {
  const source = 'a,b\n' + 'a'.repeat(50000) + ',1\nkeep,2';
  await fixture(source, async (file, path) => {
    assert.equal((await file.search({ text: '(a+)+b', regex: true })).total, 0);
    await file.edit({ row: 1, col: 1, value: 'edited' });
    const before = await values(file);
    await assert.rejects(file.change({ kind: 'replace', search: { text: 'a' }, replacement: 'x'.repeat(1000) }), /16 MB/);
    assert.deepEqual(await values(file), before); assert.equal(await readFile(path, 'utf8'), source);
  });
});

test('Invalid format changes restore the previous format after scan failure and preserve editing and saving', async () => {
  const source = 'a,b\n' + Array.from({ length: 300 }, (_, index) => `row${index},${index}`).join('\n') + '\n"quoted;part",last';
  await fixture(source, async (file, path) => {
    await assert.rejects(file.configure({ encoding: 'utf8', delimiter: ';' }));
    assert.deepEqual((await file.page(299, 2)).rows.map(row => row.values), [['row299', '299'], ['quoted;part', 'last']]);
    await file.edit({ row: 300, col: 1, value: 'recovered' });
    await file.save();
    assert.equal((await readFile(path, 'utf8')).endsWith('"quoted;part",recovered'), true);
  });
});

test('Empty files support header then row insertion and deleting all headerless rows retains the full BOM', async () => {
  await fixture('', async (file, path) => {
    await file.change({ kind: 'insertColumn', at: 0, name: 'Name' });
    await file.change({ kind: 'insertRows', at: 0, count: 1 });
    await file.change({ kind: 'cells', edits: [{ row: 0, col: 0, value: 'first' }] });
    await file.save(); assert.equal(await readFile(path, 'utf8'), 'Name\nfirst');
  });
  await fixture('\ufeffA', async (file, path) => {
    await file.change({ kind: 'deleteRows', rows: [0] }); await file.save();
    assert.deepEqual(await readFile(path), Buffer.from('\ufeff'));
  }, { hasHeader: false });
});

test('Cell and Text restoration after batch changes share the disk baseline and preserve correct undo snapshots', async () => {
  for (const channel of ['cell', 'text']) await fixture('a,b\nA,1\nB,2', async (file, path) => {
    const changed = await file.change({ kind: 'fill', selection: { start: 0, count: 1, columns: [0] }, value: 'changed' });
    if (channel === 'cell') await file.edit({ row: 0, col: 0, value: 'A' });
    else {
      const page = await file.textPage(0, 3);
      await file.textEdit({ ...page, text: page.text.replace('changed', 'A') });
    }
    assert.equal(file.changes, 0, channel);
    assert.deepEqual((await file.page(0, 1)).rows[0].modified, [], channel);
    await file.restore(changed.after); assert.equal(file.changes, 1); assert.deepEqual((await file.page(0, 1)).rows[0].modified, [0]);
    await file.restore(changed.before); assert.equal(file.changes, 0);
    await file.save(); assert.equal(await readFile(path, 'utf8'), 'a,b\nA,1\nB,2');
  });
});

test('Regex filters use linear case-insensitive patterns and reject invalid or oversized input without replacing the current view', async () => {
  await fixture('name,n\nAlpha.1,3\nALPHA.2,2\nbeta,1\n' + 'a'.repeat(50000) + ',4', async file => {
    await file.search({ text: 'alpha' });
    await file.query({ filters: [{ col: 0, text: '.' }], sort: null });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [0, 1]);
    await file.query({ filters: [{ col: 0, type: 'regex', text: '^alpha\\.[12]$' }], sort: { col: 1, direction: 1, numeric: true } });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [1, 0]);
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'regex', text: '[' }], sort: null }));
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [1, 0]);
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'regex', text: '(a)\\1' }], sort: null }));
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [1, 0]);
    assert.equal((await file.query({ filters: [{ col: 0, type: 'regex', text: '(a+)+b' }], sort: null })).total, 0);
  });
  await fixture('value\n' + 'x'.repeat(65537), async file => {
    await file.search({ text: 'x' });
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'regex', text: 'x' }], sort: null }), /65,536/);
    assert.equal((await file.page(0, 1)).total, 1);
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'regex', text: 'x'.repeat(1025) }], sort: null }), /1,024/);
  });
});

test('Distinct values scan the whole original column including edits, preserve exact values, and combine with other filters and sorting', async () => {
  const source = 'value,n\n' + Array.from({ length: 700 }, (_, index) => `common,${index}`).join('\n') + '\n01,701\n1,702\n,703\nCase,704\ncase,705\nmissing';
  await fixture(source, async (file, path) => {
    await file.search({ text: 'common' });
    await file.query({ filters: [{ col: 0, text: 'common' }], sort: null });
    await file.edit({ row: 699, col: 0, value: 'edited' });
    const result = await file.distinct(0);
    assert.equal(result.total, 8);
    assert.deepEqual(result.values, [
      { value: '', count: 1 }, { value: '01', count: 1 }, { value: '1', count: 1 }, { value: 'Case', count: 1 },
      { value: 'case', count: 1 }, { value: 'common', count: 699 }, { value: 'edited', count: 1 }, { value: 'missing', count: 1 },
    ]);
    assert.equal((await file.distinct(1)).values.find(item => item.value === '')?.count, 1);
    await file.query({ filters: [{ col: 0, type: 'values', values: ['01', '', 'Case'] }, { col: 1, type: 'number', operator: 'gte', value: 700 }], sort: { col: 1, direction: -1, numeric: true } });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.values[0]), ['Case', '', '01']);
    await assert.rejects(file.query({ filters: [{ col: 0, type: 'values', values: [] }], sort: null }), /at least one/);
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.values[0]), ['Case', '', '01']);
    await file.query({ filters: [{ col: 0, type: 'values', values: ['edited'] }], sort: null });
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [699]);
    await file.edit({ row: 699, col: 0, value: 'common' });
    assert.equal((await file.page(0, 10)).total, 0);
    assert.equal(await readFile(path, 'utf8'), source);
  });
});

test('Distinct enumeration rejects oversized complete lists rather than returning partial or truncated values', async () => {
  await fixture('value\n' + Array.from({ length: 10001 }, (_, index) => `id-${index}`).join('\n'), async file => {
    await assert.rejects(file.distinct(0), /Too many distinct values/);
    assert.equal((await file.page(10000, 1)).rows[0].values[0], 'id-10000');
  });
  const long = 'x'.repeat(8 * 1024 * 1024);
  await fixture('value\n' + long, async file => {
    await assert.rejects(file.distinct(0), /Too many distinct values/);
    assert.equal((await file.page(0, 1)).rows[0].values[0], long);
  });
  await fixture('value\n"contains\nnewline"\n"contains\nnewline"\n"quote""value"', async file => {
    assert.deepEqual((await file.distinct(0)).values, [{ value: 'contains\nnewline', count: 2 }, { value: 'quote"value', count: 1 }]);
    await file.query({ filters: [{ col: 0, type: 'values', values: ['contains\nnewline'] }], sort: null });
    assert.equal((await file.page(0, 10)).total, 2);
  });
});

test('Sparse cells calculate and edit exact sorted source coordinates without changing unselected intersections', async () => {
  const source = 'a,b,c\n1,2,3\n4,5,6\n7,8,9';
  await fixture(source, async (file, path) => {
    const query = { filters: [], sort: { col: 2, direction: -1 as const, numeric: true } };
    await file.query(query);
    const selection = { start: 0, count: 3, columns: [2, 0], ranges: [{ start: 0, count: 1 }, { start: 2, count: 1 }], cells: [{ row: 0, col: 0 }, { row: 2, col: 2 }, { row: 0, col: 0 }] };
    assert.deepEqual(await file.stats(selection.start, selection.count, selection.columns, selection.ranges, selection.cells), { count: 2, numericCount: 2, nonEmptyCount: 2, min: 3, max: 7, sum: 10, average: 5 });
    await assert.rejects(file.copy(selection.start, selection.count, selection.columns, selection.ranges, selection.cells), /rectangular selection/);
    const filled = await file.change({ kind: 'fill', selection, value: 'x' });
    await file.query({ filters: [], sort: null });
    assert.deepEqual(await values(file), [['1', '2', 'x'], ['4', '5', '6'], ['x', '8', '9']]);
    assert.equal(await readFile(path, 'utf8'), source);
    await file.restore(filled.before); await file.query(query);
    await file.change({ kind: 'replace', selection, search: { text: '[0-9]', regex: true }, replacement: 'z' });
    await file.query({ filters: [], sort: null });
    assert.deepEqual(await values(file), [['1', '2', 'z'], ['4', '5', '6'], ['z', '8', '9']]);
    await file.restore(filled.before); await file.query(query);
    const complete = [{ row: 0, col: 0 }, { row: 0, col: 2 }, { row: 2, col: 0 }, { row: 2, col: 2 }, { row: 0, col: 0 }];
    assert.equal(await file.copy(0, 3, [2, 0], selection.ranges, complete), '9\t7\n3\t1');
    const filtered = { ...query, filters: [{ col: 1, type: 'number' as const, operator: 'gte' as const, value: 5 }] };
    await file.query(filtered);
    const sparse = { start: 0, count: 2, columns: [0, 2], cells: [{ row: 1, col: 0 }, { row: 0, col: 2 }] };
    await file.change({ kind: 'fill', selection: sparse, value: '' });
    await file.query({ filters: [], sort: null });
    assert.deepEqual(await values(file), [['1', '2', '3'], ['', '5', '6'], ['7', '8', '']]);
  });
});

test('Sparse selection rejects invalid coordinates and oversized payloads before changing any data', async () => {
  await fixture('a,b\n1,2\n3,4', async file => {
    const selection = { start: 0, count: 2, columns: [0, 1] };
    for (const cells of [[], [{ row: 2, col: 0 }], [{ row: 0, col: 2 }], [{ row: NaN, col: 0 }], Array.from({ length: 100001 }, () => ({ row: 0, col: 0 }))]) {
      await assert.rejects(file.stats(0, 2, [0, 1], undefined, cells));
      await assert.rejects(file.change({ kind: 'fill', selection: { ...selection, cells }, value: 'lost' }));
      await assert.rejects(file.change({ kind: 'replace', selection: { ...selection, cells }, search: { text: '.' , regex: true }, replacement: 'lost' }));
      assert.deepEqual(await values(file), [['1', '2'], ['3', '4']]); assert.equal(file.changes, 0);
    }
  });
});

test('Data checks page beyond 200 issues, include same-row columns, and keep global totals on the final page', async () => {
  await fixture('a,b\n' + ',\n'.repeat(205), async file => {
    const first = await file.check({ kind: 'missing' });
    assert.equal(first.total, 410); assert.equal(first.issues.length, 200); assert.equal(first.truncated, true);
    const second = await file.check({ kind: 'missing', after: first.issues.at(-1) });
    assert.equal(second.total, 410); assert.equal(second.issues[0].row, 100); assert.equal(second.truncated, true);
    const last = await file.check({ kind: 'missing', after: second.issues.at(-1) });
    assert.equal(last.total, 410); assert.equal(last.issues.length, 10); assert.equal(last.truncated, false);
    const sparse = await file.check({ kind: 'missing', after: { row: 204, col: 0 } });
    assert.deepEqual(sparse.issues.map(issue => [issue.row, issue.col]), [[204, 1]]); assert.equal(sparse.truncated, false);
  });
  await fixture('a,b\n' + 'only\n'.repeat(205), async file => {
    const first = await file.check({ kind: 'ragged' });
    const last = await file.check({ kind: 'ragged', after: first.issues.at(-1) });
    assert.equal(last.total, 205); assert.equal(last.issues.length, 5); assert.equal(last.truncated, false);
  });
});

test('Renaming a real header preserves source fields, quoting, view state, cell edits, and undo/save', async () => {
  const source = '\ufeff"Product",n\r\n"first\nitem",2\nsecond,1';
  await fixture(source, async (file, path, directory) => {
    await file.edit({ row: 0, col: 1, value: '3' });
    await file.query({ filters: [{ col: 1, type: 'number', operator: 'gte', value: 1 }], sort: { col: 1, direction: 1, numeric: true } });
    await file.pinRows([0]);
    const renamed = await file.change({ kind: 'renameColumn', col: 0, name: 'Item,"name"\nlabel' });
    assert.deepEqual(renamed.metadata.headers, ['Item,"name"\nlabel', 'n']);
    assert.deepEqual(renamed.metadata.modifiedHeaders, [0]);
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [0, 1]);
    assert.deepEqual((await file.page(0, 10)).rows[0].modified, [1]);
    assert.equal(await readFile(path, 'utf8'), source);
    const copy = join(directory, 'renamed.csv');
    await file.save(copy);
    assert.equal(await readFile(copy, 'utf8'), '\ufeff"Item,""name""\nlabel",n\r\n"first\nitem",3\nsecond,1');
    const undone = await file.restore(renamed.before);
    assert.deepEqual(undone.metadata.headers, ['Product', 'n']);
    assert.deepEqual(undone.metadata.modifiedHeaders, []);
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.id), [0, 1]);
    const redone = await file.restore(renamed.after);
    assert.deepEqual(redone.metadata.modifiedHeaders, [0]);
    assert.equal(redone.changes, 2);
    const reset = await file.change({ kind: 'renameColumn', col: 0, name: 'Product' });
    assert.deepEqual(reset.metadata.modifiedHeaders, []);
    assert.equal(reset.changes, 1);
    const unchanged = await file.change({ kind: 'renameColumn', col: 0, name: 'Product' });
    assert.equal(unchanged.before, '');
    await file.save();
    assert.deepEqual((await file.page(0, 1)).rows[0].modified, []);
    assert.equal(await readFile(path, 'utf8'), source.replace(',2\n', ',3\n'));
    assert.deepEqual((await file.change({ kind: 'renameColumn', col: 1, name: 'amount' })).metadata.modifiedHeaders, [1]);
  });
});

test('Synthetic header names cannot overwrite a headerless CSV first data record', async () => {
  await fixture('first,1\nsecond,2', async (file, path) => {
    await assert.rejects(file.change({ kind: 'renameColumn', col: 0, name: 'name' }), /real header/);
    assert.equal(file.changes, 0);
    assert.deepEqual(await values(file), [['first', '1'], ['second', '2']]);
    assert.equal(await readFile(path, 'utf8'), 'first,1\nsecond,2');
  }, { hasHeader: false });
});

test('Header change markers follow content column moves and Text edits without comparing unrelated source columns', async () => {
  await fixture('a,b,c\n1,2,3', async file => {
    await file.change({ kind: 'renameColumn', col: 0, name: 'alpha' });
    const move = await file.change({ kind: 'moveColumn', col: 0, before: 3 });
    assert.deepEqual(move.metadata.headers, ['b', 'c', 'alpha']);
    assert.deepEqual(move.metadata.modifiedHeaders, [2]);
    assert.deepEqual((await file.change({ kind: 'renameColumn', col: 2, name: 'a' })).metadata.modifiedHeaders, []);
    const page = await file.textPage(0, 1);
    await file.textEdit({ start: 0, count: 1, revision: page.revision, text: 'beta,c,a\n' });
    const change = await file.change({ kind: 'renameColumn', col: 1, name: 'gamma' });
    assert.deepEqual(change.metadata.modifiedHeaders, [0, 1]);
    const inserted = await file.change({ kind: 'insertColumn', at: 1, name: 'new' });
    assert.deepEqual(inserted.metadata.modifiedHeaders, [0, 2]);
    assert.deepEqual((await file.change({ kind: 'deleteColumns', columns: [0] })).metadata.modifiedHeaders, [1]);
    assert.deepEqual(await values(file), [['', '3', '1']]);
  });
});

test('Inserted columns retain their positions through headerless moves, deletion, undo and save', async () => {
  await fixture('1,2\n3,4', async (file, path, directory) => {
    const inserted = await file.change({ kind: 'insertColumn', at: 1, name: 'ignored' });
    assert.deepEqual(inserted.metadata.insertedColumns, [1]);
    const moved = await file.change({ kind: 'moveColumn', col: 1, before: 3 });
    assert.deepEqual(moved.metadata.insertedColumns, [2]);
    assert.deepEqual(await values(file), [['1', '2', ''], ['3', '4', '']]);
    const removed = await file.change({ kind: 'deleteColumns', columns: [0] });
    assert.deepEqual(removed.metadata.insertedColumns, [1]);
    await file.restore(removed.before);
    assert.deepEqual((await file.page(0, 10)).insertedColumns, [2]);
    await file.restore(moved.before);
    assert.deepEqual((await file.page(0, 10)).insertedColumns, [1]);
    await file.restore(inserted.before);
    assert.deepEqual((await file.page(0, 10)).insertedColumns, []);
    assert.deepEqual(await values(file), [['1', '2'], ['3', '4']]);
    assert.equal(file.changes, 0);
    await file.restore(removed.after);
    await file.save(join(directory, 'copy.csv'));
    assert.deepEqual((await file.page(0, 10)).insertedColumns, [1]);
    assert.equal(await readFile(path, 'utf8'), '1,2\n3,4');
    await file.save();
    assert.deepEqual((await file.page(0, 10)).insertedColumns, []);
    assert.deepEqual(await values(file), [['2', ''], ['4', '']]);
  }, { hasHeader: false });
});

test('Inserted rows stay attached to their content through moves, deletion, query projection and undo', async () => {
  await fixture('name\nA\nB\nC\nD', async file => {
    const inserted = await file.change({ kind: 'insertRows', at: 1, count: 2 });
    const markers = async () => (await file.page(0, 20)).rows.filter(row => row.inserted).map(row => row.id);
    assert.deepEqual(await markers(), [1, 2]);
    await file.edit({ row: 1, col: 0, value: 'New' });
    const moved = await file.change({ kind: 'moveRow', row: 1, before: 6 });
    assert.deepEqual(await markers(), [1, 5]);
    await file.pinRows([5]);
    assert.deepEqual((await file.page(0, 20)).rows.filter(row => row.inserted).map(row => row.values[0]), ['New', '']);
    await file.query({ filters: [{ col: 0, text: 'New' }], sort: null });
    assert.deepEqual(await markers(), [5]);
    await file.query({ filters: [], sort: null });
    const removed = await file.change({ kind: 'deleteRows', rows: [1, 5] });
    assert.deepEqual(await markers(), []);
    assert.deepEqual(await values(file), [['A'], ['B'], ['C'], ['D']]);
    await file.restore(removed.before); assert.deepEqual(await markers(), [1, 5]);
    await file.restore(moved.before); assert.deepEqual(await markers(), [1, 2]);
    await file.restore(inserted.before); assert.deepEqual(await markers(), []);
    assert.equal(file.changes, 0);
  });
});

test('Inserted cells retain creation state independently of later content edits and clear on overwrite', async () => {
  await fixture('a,b\n1,2\n3,4', async (file, path, directory) => {
    const inserted = await file.change({ kind: 'insertRows', at: 1, count: 2 });
    let rows = (await file.page(0, 10)).rows;
    assert.deepEqual(rows.map(row => row.modified), [[], [], [], []]);
    assert.deepEqual(rows.filter(row => row.inserted).map(row => row.id), [1, 2]);
    const edited = await file.change({ kind: 'cells', edits: [{ row: 1, col: 1, value: 'new content' }] });
    rows = (await file.page(0, 10)).rows;
    assert.deepEqual(rows.map(row => row.modified), [[], [1], [], []]);
    await file.restore(edited.before);
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.modified), [[], [], [], []]);
    await file.restore(edited.after);
    assert.deepEqual((await file.page(0, 10)).rows[1].modified, [1]);
    const copy = join(directory, 'inserted.csv'); await file.save(copy);
    assert.deepEqual((await file.page(0, 10)).rows[1].modified, [1]);
    await file.save();
    assert.deepEqual((await file.page(0, 10)).rows.map(row => row.modified), [[], [], [], []]);
    const addedColumn = await file.change({ kind: 'insertColumn', at: 1, name: 'new' });
    assert.deepEqual(addedColumn.metadata.insertedColumns, [1]);
    assert.equal((await file.page(0, 10)).rows.every(row => !row.modified.length), true);
    const cell = await file.change({ kind: 'cells', edits: [{ row: 0, col: 1, value: 'value' }] });
    assert.deepEqual((await file.page(0, 10)).rows[0].modified, [1]);
    await file.restore(cell.before);
    assert.equal((await file.page(0, 10)).rows.every(row => !row.modified.length), true);
    assert.equal((await readFile(path, 'utf8')).includes('value'), false);
    assert.ok(inserted.before);
  });
});

test('Row moves keep independent cell changes attached to their records', async () => {
  const source = 'ID,A,B\nr0,a0,b0\nr1,a1,b1\nr2,a2,b2\nr3,a3,b3\nr4,a4,b4\n';
  await fixture(source, async (file, path, directory) => {
    await file.edit({ row: 0, col: 1, value: 'edited first' });
    await file.edit({ row: 2, col: 2, value: 'edited middle' });
    await file.edit({ row: 4, col: 1, value: 'edited moved' });
    const markers = async () => (await file.page(0, 20)).rows.map(row => [row.values[0], row.modified]);
    const original = [['r0', [1]], ['r1', []], ['r2', [2]], ['r3', []], ['r4', [1]]];
    const up = await file.change({ kind: 'moveRow', row: 4, before: 1 });
    const moved = [['r0', [1]], ['r4', [1]], ['r1', []], ['r2', [2]], ['r3', []]];
    assert.deepEqual(await markers(), moved);
    await file.restore(up.before); assert.deepEqual(await markers(), original);
    await file.restore(up.after); assert.deepEqual(await markers(), moved);
    await file.change({ kind: 'moveRow', row: 1, before: 5 });
    assert.deepEqual(await markers(), original);
    await file.save(join(directory, 'copy.csv')); assert.deepEqual(await markers(), original);
    assert.equal(await readFile(path, 'utf8'), source);
    await file.save();
    assert.equal((await file.page(0, 20)).rows.every(row => !row.modified.length), true);
  });
});

test('Structural inserts and deletions remap prior cell changes and discard only deleted cells', async () => {
  const source = 'ID,A,B\nr0,a0,b0\nr1,a1,b1\nr2,a2,b2\n';
  const cases: { operation: ChangeOperation; expected: [string, number[]][] }[] = [
    { operation: { kind: 'insertRows', at: 1, count: 2 }, expected: [['r0', [1]], ['', []], ['', []], ['r1', [2]], ['r2', [1]]] },
    { operation: { kind: 'deleteRows', rows: [0] }, expected: [['r1', [2]], ['r2', [1]]] },
    { operation: { kind: 'insertColumn', at: 1, name: 'new' }, expected: [['r0', [2]], ['r1', [3]], ['r2', [2]]] },
    { operation: { kind: 'deleteColumns', columns: [1] }, expected: [['r0', []], ['r1', [1]], ['r2', []]] },
    { operation: { kind: 'moveColumn', col: 1, before: 3 }, expected: [['r0', [2]], ['r1', [1]], ['r2', [2]]] },
  ];
  for (const { operation, expected } of cases) await fixture(source, async file => {
    await file.edit({ row: 0, col: 1, value: 'changed0' });
    await file.edit({ row: 1, col: 2, value: 'changed1' });
    await file.change({ kind: 'fill', selection: { start: 2, count: 1, columns: [1] }, value: 'changed2' });
    const markers = async () => (await file.page(0, 20)).rows.map(row => [row.values[0], row.modified]);
    const before = await markers();
    const change = await file.change(operation);
    assert.deepEqual(await markers(), expected, operation.kind);
    await file.restore(change.before); assert.deepEqual(await markers(), before);
    await file.restore(change.after); assert.deepEqual(await markers(), expected);
  });
});

test('Undoing a row move and then the earlier cell edits clears every cell marker and restores original bytes', async () => {
  const source = 'ID,A,B\r\nr0,"a0",b0\r\nr1,a1,b1\r\nr2,a2,b2';
  await fixture(source, async (file, path, directory) => {
    await file.edit({ row: 0, col: 1, value: 'edited0' });
    await file.edit({ row: 2, col: 2, value: 'edited2' });
    const move = await file.change({ kind: 'moveRow', row: 1, before: 0 });
    await file.restore(move.before);
    await file.edit({ row: 2, col: 2, value: 'b2' });
    assert.deepEqual((await file.page(0, 20)).rows.map(row => row.modified), [[1], [], []]);
    await file.edit({ row: 0, col: 1, value: 'a0' });
    assert.deepEqual((await file.page(0, 20)).rows.map(row => row.modified), [[], [], []]);
    assert.equal(file.changes, 0);
    const copy = join(directory, 'undone.csv'); await file.save(copy);
    assert.equal(await readFile(copy, 'utf8'), source);
    assert.equal(await readFile(path, 'utf8'), source);
    const fresh = await file.change({ kind: 'moveRow', row: 1, before: 0 });
    assert.deepEqual((await file.page(0, 20)).rows.map(row => row.modified), [[], [], []]);
    await file.restore(fresh.before); assert.equal(file.changes, 0);
  });
});

test('Mixed cell edits and row/column structure changes restore every value and marker through full Undo and Redo', async () => {
  const source = '\ufeffID,A,B\r\nr0,"a0",b0\r\nr1,"line one\nline two",b1\r\nr2,a2,b2';
  await fixture(source, async (file, path, directory) => {
    const state = async () => {
      const page = await file.page(0, 20);
      const text = await file.textPage(0, 20);
      return { rows: page.rows, insertedColumns: page.insertedColumns, text: text.text, changes: file.changes };
    };
    const operations: ChangeOperation[] = [
      { kind: 'cells', edits: [{ row: 0, col: 1, value: 'edited first' }, { row: 2, col: 2, value: 'edited last' }] },
      { kind: 'insertRows', at: 1, count: 2 },
      { kind: 'insertColumn', at: 1, name: 'New' },
      { kind: 'cells', edits: [{ row: 1, col: 1, value: 'new content' }] },
      { kind: 'moveRow', row: 4, before: 0 },
      { kind: 'moveColumn', col: 3, before: 0 },
      { kind: 'deleteRows', rows: [2] },
      { kind: 'deleteColumns', columns: [2] },
      { kind: 'renameColumn', col: 0, name: 'Changed' },
    ];
    const snapshots = [await state()];
    const history: { before: string; after: string }[] = [];
    for (const operation of operations) {
      history.push(await file.change(operation));
      snapshots.push(await state());
    }
    for (let index = history.length - 1; index >= 0; index--) {
      await file.restore(history[index].before);
      assert.deepEqual(await state(), snapshots[index], `Undo operation ${index + 1}`);
    }
    assert.equal(file.changes, 0);
    const originalCopy = join(directory, 'original.csv'); await file.save(originalCopy);
    assert.equal(await readFile(originalCopy, 'utf8'), source);
    for (let index = 0; index < history.length; index++) {
      await file.restore(history[index].after);
      assert.deepEqual(await state(), snapshots[index + 1], `Redo operation ${index + 1}`);
    }
    const copy = join(directory, 'copy.csv'); await file.save(copy);
    assert.deepEqual(await state(), snapshots.at(-1));
    assert.equal(await readFile(path, 'utf8'), source);
    await file.save();
    const saved = await file.page(0, 20);
    assert.equal(file.changes, 0);
    assert.deepEqual(saved.insertedColumns, []);
    assert.equal(saved.rows.every(row => !row.inserted && !row.modified.length), true);
    assert.equal(await readFile(path, 'utf8'), await readFile(copy, 'utf8'));
  });
});
