/*
Purpose: Isolate the VS Code UI boundary and use real workers to verify saving, recovery, and header settings.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { CsvDocument } from '../src/CsvDocument';
import { VersionHistory } from '../src/VersionHistory';

const vscodeMock = `
const { fileURLToPath, pathToFileURL } = require('node:url');
exports.EventEmitter = class { event = () => ({ dispose() {} }); fire() {} dispose() {} };
exports.Uri = { file: path => ({ fsPath: path, scheme: 'file', toString: () => pathToFileURL(path).href }), parse: uri => exports.Uri.file(fileURLToPath(uri)) };
`;

test('Reordered overwrite, history recovery, and Save As maintain a consistent document baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-document-'));
  let document: CsvDocument | undefined;
  try {
    const worker = join(directory, 'worker.cjs'), host = join(directory, 'host.cjs');
    await Promise.all([
      build({ entryPoints: ['src/engine/worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: worker }),
      build({ entryPoints: ['src/CsvDocument.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'vscode-test-boundary', setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: vscodeMock, loader: 'js' }));
      } }] }),
    ]);
    const require = createRequire(__filename);
    const { CsvDocument: Document } = require(host) as { CsvDocument: typeof CsvDocument };
    const path = join(directory, 'input.csv');
    const original = 'name,n\nkeep,3\ndrop,1\nkeep,2\n';
    await writeFile(path, original);
    const uri = { fsPath: path, scheme: 'file', toString: () => new URL(`file://${path}`).href };
    document = await Document.open(uri as never, worker);
    const history = new VersionHistory(join(directory, 'history'));
    const wait = async () => {
      while (!document!.metadata?.complete) await new Promise(resolve => setTimeout(resolve, 2));
    };
    await wait();
    await document.edit({ row: 0, col: 1, value: '4' });
    document.query = { filters: [{ col: 0, text: 'keep' }], sort: { col: 1, direction: 1, numeric: true } };
    await document.refresh();
    await document.save(undefined, { edits: true, sort: true, filters: true }, history);
    await wait();
    assert.equal(await readFile(path, 'utf8'), 'name,n\nkeep,2\nkeep,4\n');
    assert.equal(document.changes, 0);
    assert.deepEqual(document.query, { filters: [], sort: null });
    const [version] = await history.list(path);
    const snapshot = await history.get(path, version.id);
    await document.recover(snapshot.path, snapshot.version.hasHeader, history);
    await wait();
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(document.changes, 0);
    // Recovery must retain the selected source even when capturing a version evicts that oldest snapshot.
    for (let i = 0; i < 6; i++) {
      await history.capture(path, true);
    }
    const versions = await history.list(path);
    const oldest = await history.get(path, versions[versions.length - 1].id);
    await document.recover(oldest.path, oldest.version.hasHeader, history);
    await wait();
    assert.equal(await readFile(path, 'utf8'), original);
    for (let i = 0; i < 6; i++) {
      await document.header(i % 2 === 1); await wait();
      assert.equal(document.metadata?.rows, i % 2 === 0 ? 4 : 3);
    }
    await document.edit({ row: 0, col: 1, value: 'edited' });
    const copy = { fsPath: join(directory, 'export.csv'), scheme: 'file', toString: () => 'file:///export.csv' };
    await document.save(copy as never, { edits: true, sort: false, filters: false }, history);
    assert.equal(document.changes, 1);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.match(await readFile(copy.fsPath, 'utf8'), /keep,edited/);
    await assert.rejects(document.recover(snapshot.path, true, history), /Save your edits/);
    await document.save(undefined, { edits: false, sort: false, filters: false }, history);
    assert.equal(document.changes, 0);
    assert.equal(await readFile(path, 'utf8'), original);
    const events: Parameters<CsvDocument['onEdit']>[0][] = [];
    document.onEdit = event => events.push(event);
    const page = await document.textPage(0, 200);
    await document.textEdit({ ...page, text: page.text.replace('keep,3', 'text,3') });
    assert.equal((await document.textPage(0, 200)).text, original.replace('keep,3', 'text,3'));
    await events.at(-1)!.undo();
    assert.equal((await document.textPage(0, 200)).text, original);
    assert.equal(document.changes, 0);
    await events.at(-1)!.redo();
    await document.edit({ row: 0, col: 1, value: '9' });
    assert.match((await document.textPage(0, 200)).text, /text,9/);
    await events.at(-1)!.undo();
    assert.match((await document.textPage(0, 200)).text, /text,3/);
    const valid = await document.textPage(0, 200);
    await document.textEdit({ ...valid, text: 'name,n\n"unfinished' });
    assert.ok(document.textDraft);
    await assert.rejects(document.save(), /CSV syntax/);
    const backupPath = join(directory, 'draft-backup.csv');
    const backupUri = { fsPath: backupPath, scheme: 'file', toString: () => new URL(`file://${backupPath}`).href };
    const backupId = await document.backup(backupUri as never);
    const restored = await Document.open(uri as never, worker, backupId);
    try {
      assert.equal((await restored.textPage(0, 200)).text, 'name,n\n"unfinished');
      assert.ok((await restored.textPage(0, 200)).draftError);
      await assert.rejects(restored.save(), /CSV syntax/);
    } finally { restored.dispose(); }
    await events.at(-1)!.undo();
    assert.equal(document.textDraft, undefined);
    await document.save(); await wait();
    assert.equal(await readFile(path, 'utf8'), original.replace('keep,3', 'text,3'));
    const quoted = 'name,n\n"keep","3"\n';
    await writeFile(path, quoted); await document.revert(); await wait(); events.length = 0;
    await document.edit({ row: 0, col: 0, value: 'cell' });
    const mixed = await document.textPage(0, 200);
    await document.textEdit({ ...mixed, text: mixed.text.replace('"3"', '"4"') });
    await events[1].undo(); await events[0].undo();
    assert.equal(document.changes, 0);
    assert.equal((await document.textPage(0, 200)).text, quoted);
    await document.save(); await wait();
    assert.equal(await readFile(path, 'utf8'), quoted);
    const expanded = 'name,n\n' + Array.from({ length: 500 }, (_, index) => `row${index},${index}\n`).join('');
    await writeFile(path, expanded); await document.revert(); await wait(); events.length = 0;
    const window = await document.textPage(0, 400);
    await document.textEdit({ ...window, text: '"' + window.text });
    const draftWindow = await document.textPage(0, 200);
    assert.equal(draftWindow.count, 400);
    assert.equal(draftWindow.text, '"' + window.text);
    assert.ok(draftWindow.draftError);
    await events.at(-1)!.undo();
    assert.equal(document.textDraft, undefined);
    assert.equal(document.changes, 0);
    await writeFile(path, 'external,change\n');
    await assert.rejects(document.save(undefined, undefined, history), /changed on disk/);
    assert.equal(await readFile(path, 'utf8'), 'external,change\n');
  } finally { document?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
