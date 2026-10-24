/*
Purpose: Verify activation, table opening, and text switching in a real VS Code extension host.
*/
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvDocument } from '../src/CsvDocument';
import { SampleCsv } from '../src/SampleCsv';

export async function run(): Promise<void> {
  const report = '/tmp/vscode-csv-smoke-result.json';
  const fixtureFolder = await mkdtemp(join(tmpdir(), 'csv-editor-smoke-'));
  try {
    const extension = vscode.extensions.getExtension('local-tools.vscode-csv');
    assert.ok(extension, 'CSV Table is registered in VS Code');
    await extension.activate();
    await verifyDocumentLifecycle(extension.extensionPath);
    await verifyHeaderlessDocument(extension.extensionPath);
    await verifyProgressiveSortedSave(extension.extensionPath);
    const fixture = vscode.Uri.file(join(fixtureFolder, 'input.csv'));
    await SampleCsv.create(fixture.fsPath, 'small');
    await vscode.commands.executeCommand('vscode.openWith', fixture, 'vscode-csv.editor');
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputCustom, 'CSV opens in a custom editor');
    const input = tab.input;
    assert.equal(input.viewType, 'vscode-csv.editor');
    const before = await vscode.workspace.fs.readFile(input.uri);
    assert.ok(before.byteLength > 1000);
    await vscode.commands.executeCommand('workbench.action.files.save');
    assert.deepEqual(await vscode.workspace.fs.readFile(input.uri), before, 'Saving an unmodified document preserves bytes');
    await vscode.commands.executeCommand('vscode.openWith', input.uri, 'default');
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText, 'Open as text works');
    await vscode.commands.executeCommand('vscode-csv.open', input.uri);
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom, 'Reopen as table works');
    await writeFile(report, JSON.stringify({ passed: true, vscode: vscode.version, fixture: input.uri.fsPath, checks: ['activate', 'custom-editor', 'save-preserves-bytes', 'text-reopen', 'edit-save', 'undo-redo-after-save', 'query-after-save', 'backup-conflict', 'orphan-backup-save-as', 'progressive-sorted-save-20000-rows', 'headerless-first-row-edit-save', 'header-switch-dirty-guard', 'headerless-backup-restore', 'copy-current-view'] }, null, 2));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } catch (error) {
    await writeFile(report, JSON.stringify({ passed: false, error: String(error) }, null, 2));
    throw error;
  } finally { await rm(fixtureFolder, { recursive: true, force: true }); }
}

async function verifyHeaderlessDocument(extensionPath: string): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'csv-headerless-smoke-'));
  const docs: CsvDocument[] = [];
  try {
    const source = join(folder, 'source.csv');
    await writeFile(source, 'first,2\nsecond,1\n');
    const worker = join(extensionPath, 'dist', 'worker.js');
    const uri = vscode.Uri.file(source);
    const doc = await CsvDocument.open(uri, worker);
    docs.push(doc);
    assert.equal((await doc.header(false)).hasHeader, false);
    let priorHistory: vscode.CustomDocumentEditEvent<CsvDocument> | undefined;
    doc.onEdit = event => { priorHistory = event; };
    await doc.edit({ row: 0, col: 0, value: 'changed' });
    await assert.rejects(doc.header(true), /Save your changes/);
    await doc.save();
    assert.equal(await readFile(source, 'utf8'), 'changed,2\nsecond,1\n');
    await doc.engine.request({ method: 'query', query: { filters: [], sort: { col: 1, direction: 1, numeric: true } } });
    assert.equal(await doc.engine.request({ method: 'copy', start: 0, count: 2, columns: [1, 0] }), '1\tsecond\n2\tchanged');
    const backup = await doc.backup(vscode.Uri.file(join(folder, 'backup.csv')));
    const restored = await CsvDocument.open(uri, worker, backup);
    docs.push(restored);
    assert.equal(restored.metadata?.hasHeader, false);
    await restored.revert();
    assert.equal(restored.metadata?.hasHeader, false);
    await doc.header(true);
    await priorHistory?.undo();
    assert.equal(doc.changes, 0, 'History from a previous header interpretation cannot edit another record');
  } finally {
    for (const doc of docs) doc.dispose();
    await rm(folder, { recursive: true, force: true });
  }
}

async function verifyDocumentLifecycle(extensionPath: string): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'csv-document-smoke-'));
  const source = join(folder, 'source.csv');
  const uri = vscode.Uri.file(source);
  const worker = join(extensionPath, 'dist', 'worker.js');
  const docs: CsvDocument[] = [];
  try {
    await writeFile(source, 'id,value\n1,before\n2,other\n');
    const document = await CsvDocument.open(uri, worker);
    docs.push(document);
    let history: vscode.CustomDocumentEditEvent<CsvDocument> | undefined;
    document.onEdit = event => { history = event; };
    document.query = { filters: [], sort: { col: 1, direction: -1, numeric: false } };
    await document.engine.request({ method: 'query', query: document.query });
    await document.edit({ row: 0, col: 1, value: 'after' });
    assert.ok(history);
    await document.save();
    const sorted = await document.engine.request({ method: 'page', start: 0, count: 2 }) as { rows: { id: number }[] };
    assert.equal(sorted.rows[0].id, 1, 'Save preserves the active sort view');
    assert.equal(await readFile(source, 'utf8'), 'id,value\n1,after\n2,other\n');
    await history.undo();
    await document.save();
    assert.equal(await readFile(source, 'utf8'), 'id,value\n1,before\n2,other\n');
    await history.redo();
    const backup = await document.backup(vscode.Uri.file(join(folder, 'backup.csv')));
    document.dispose();
    await writeFile(source, 'id,value\n1,external-change\n2,other\n');
    const restored = await CsvDocument.open(uri, worker, backup);
    docs.push(restored);
    assert.ok(restored.changes > 0, 'Restored backup can be saved');
    await assert.rejects(restored.save(), /changed on disk/);
    const savedAs = join(folder, 'saved-as.csv');
    await restored.save(vscode.Uri.file(savedAs));
    assert.equal(await readFile(savedAs, 'utf8'), 'id,value\n1,after\n2,other\n');
    restored.dispose();
    await unlink(source);
    const orphan = await CsvDocument.open(uri, worker, backup);
    docs.push(orphan);
    await orphan.save(vscode.Uri.file(join(folder, 'recovered.csv')));
    assert.equal(await readFile(join(folder, 'recovered.csv'), 'utf8'), 'id,value\n1,after\n2,other\n');
  } finally {
    for (const document of docs) document.dispose();
    await rm(folder, { recursive: true, force: true });
  }
}

async function verifyProgressiveSortedSave(extensionPath: string): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'csv-progressive-smoke-'));
  let document: CsvDocument | undefined;
  try {
    const file = join(folder, 'progressive.csv');
    await writeFile(file, 'id,value\n' + Array.from({ length: 20000 }, (_, i) => `${i},row ${i} with content`).join('\n') + '\n');
    document = await CsvDocument.open(vscode.Uri.file(file), join(extensionPath, 'dist', 'worker.js'));
    const doc = document;
    if (!doc.metadata?.complete) await new Promise<void>((resolve, reject) => {
      doc.notify = message => {
        if (message.type === 'metadata' && message.data.complete) resolve();
        if (message.type === 'error') reject(new Error(message.message));
      };
    });
    doc.query = { filters: [], sort: { col: 0, direction: -1, numeric: true } };
    await doc.engine.request({ method: 'query', query: doc.query });
    await doc.edit({ row: 0, col: 1, value: 'changed' });
    await doc.save();
    const page = await doc.run(() => doc.engine.request({ method: 'page', start: 0, count: 2 })) as { rows: { id: number }[] };
    assert.equal(page.rows[0].id, 19999, 'Progressive reload restores sorting before pages are served');
    assert.match(await readFile(file, 'utf8'), /^id,value\n0,changed\n1,/);
  } finally {
    document?.dispose();
    await rm(folder, { recursive: true, force: true });
  }
}
