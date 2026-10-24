/*
Purpose: Verify native cancellation, discard, and overwrite with real documents and workers, without VS Code windows.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import iconv from 'iconv-lite';
import { VersionHistory } from '../src/VersionHistory';
import type { CsvDocument } from '../src/CsvDocument';
import type { HostPrompt } from '../src/protocol';
import type { CustomDocumentEditEvent } from 'vscode';

type SaveProvider = {
  openCustomDocument(uri: unknown, context: unknown): Promise<CsvDocument>;
  saveCustomDocument(document: CsvDocument): Promise<void>;
};
const boundary = globalThis as typeof globalThis & { csvSaveTestProvider?: SaveProvider };
const vscodeMock = `
const { pathToFileURL, fileURLToPath } = require('node:url');
exports.EventEmitter = class { event = () => ({dispose(){}}); fire(){} dispose(){} };
exports.CancellationError = class CancellationError extends Error { constructor(){ super('Canceled'); this.name = 'CancellationError'; } };
exports.Uri = { file: path => ({ fsPath: path, scheme: 'file', toString: () => pathToFileURL(path).href }), parse: uri => exports.Uri.file(fileURLToPath(uri)), joinPath: (uri, ...parts) => exports.Uri.file(require('node:path').join(uri.fsPath,...parts)) };
exports.window = { showQuickPick: async items => items.find(item => item.encoding === 'gb18030'), registerCustomEditorProvider: (_, provider) => { globalThis.csvSaveTestProvider = provider; return {dispose(){}}; } };
exports.workspace = { getConfiguration: () => ({ get: (_, fallback) => fallback }) };
exports.commands = { registerCommand: () => ({dispose(){}}) };
exports.env = { clipboard: {
  readText: async () => { const state = globalThis.csvClipboardTest; if (state.failRead) throw new Error('Clipboard read unavailable'); return state.text; },
  writeText: async text => { const state = globalThis.csvClipboardTest; if (state.failWrite) throw new Error('Clipboard write unavailable'); state.text = text; },
} };
`;

test('Native documents protect cancellation, discard, batch undo, backup recovery, encoding export, and disk conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-save-lifecycle-'));
  let document: CsvDocument | undefined;
  try {
    const host = join(directory, 'host.cjs'), worker = join(directory, 'worker.cjs');
    await Promise.all([
      build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'save-test-vscode', setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: vscodeMock, loader: 'js' }));
      } }] }),
      build({ entryPoints: ['src/engine/worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: worker }),
    ]);
    const { activate } = createRequire(__filename)(host);
    const path = join(directory, 'input.csv'), original = 'name,n\noriginal,1\n';
    await writeFile(path, original);
    const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => new URL(`file://${fsPath}`).href });
    activate({ subscriptions: [], globalStorageUri: uri(directory), globalState: { get: (_: string, fallback: unknown) => fallback, update: async () => {} }, workspaceState: { get: (_: string, fallback: unknown) => fallback, update: async () => {} }, asAbsolutePath: () => worker });
    const provider = boundary.csvSaveTestProvider!;
    document = await provider.openCustomDocument(uri(path), {});
    await document.edit({ row: 0, col: 0, value: 'changed' });
    document.chooseSave = async (saveAs, allowDiscard) => { assert.equal(saveAs, false); assert.equal(allowDiscard, true); return null; };
    await assert.rejects(provider.saveCustomDocument(document), { name: 'CancellationError' });
    assert.equal(document.changes, 1); assert.equal(await readFile(path, 'utf8'), original);
    document.chooseSave = async () => ({ discard: true });
    await provider.saveCustomDocument(document);
    assert.equal(document.changes, 0); assert.equal(await readFile(path, 'utf8'), original);
    const page = await document.textPage(0, 200);
    await document.textEdit({ ...page, text: 'name,n\n"unfinished' });
    assert.ok(document.textDraft);
    await provider.saveCustomDocument(document);
    assert.equal(document.textDraft, undefined); assert.equal(document.changes, 0);
    assert.equal(await readFile(path, 'utf8'), original);
    await document.edit({ row: 0, col: 0, value: 'saved' });
    document.chooseSave = async () => ({ saveAs: false, options: { edits: true, sort: false, filters: false } });
    await provider.saveCustomDocument(document);
    assert.equal(await readFile(path, 'utf8'), 'name,n\nsaved,1\n');
    assert.equal(document.changes, 0);

    const edits: CustomDocumentEditEvent<CsvDocument>[] = [];
    document.onEdit = edit => edits.push(edit);
    await document.change({ kind: 'insertRows', at: 1, count: 1 });
    await document.change({ kind: 'paste', row: 1, columns: [0, 1], text: 'pasted\t42' });
    assert.equal(edits.length, 2);
    assert.match((await document.textPage(0, 10)).text, /pasted,42/);

    const encodedPath = join(directory, 'encoded.csv');
    await writeFile(encodedPath, iconv.encode('name;n\n中文;1\n', 'gb18030'));
    const encoded = await provider.openCustomDocument(uri(encodedPath), {});
    try {
      await encoded.configure({ encoding: 'gbk', delimiter: ';' });
      assert.match((await encoded.textPage(0, 10)).text, /中文;1/);
      await encoded.edit({ row: 0, col: 0, value: '😀' });
      await assert.rejects(encoded.save(), /cannot be saved/);
      assert.equal(iconv.decode(await readFile(encodedPath), 'gb18030'), 'name;n\n中文;1\n');
      const encodedBackupId = await encoded.backup(uri(join(directory, 'encoded-backup.csv')) as never);
      const fromBackup = await provider.openCustomDocument(uri(encodedPath), { backupId: encodedBackupId });
      try {
        assert.match((await fromBackup.textPage(0, 10)).text, /😀;1/);
        assert.equal(fromBackup.format.encoding, 'gbk');
        await fromBackup.save(uri(join(directory, 'utf8-export.csv')) as never, { edits: true, sort: false, filters: false, encoding: 'utf8' });
        assert.match(await readFile(join(directory, 'utf8-export.csv'), 'utf8'), /😀;1/);
        assert.ok(fromBackup.changes);
        const versions = new VersionHistory(join(directory, 'encoded-history'));
        await fromBackup.save(undefined, { edits: true, sort: false, filters: false, encoding: 'utf8' }, versions);
        assert.match(await readFile(encodedPath, 'utf8'), /😀;1/);
        assert.equal(fromBackup.format.encoding, 'utf8');
        assert.equal(fromBackup.changes, 0);
        const savedVersion = (await versions.list(encodedPath))[0];
        assert.equal(savedVersion.format?.encoding, 'gbk');
        const snapshot = await versions.get(encodedPath, savedVersion.id);
        await fromBackup.recover(snapshot.path, snapshot.version.hasHeader, versions, snapshot.version.format);
        assert.equal(fromBackup.format.encoding, 'gbk');
        assert.match((await fromBackup.textPage(0, 10)).text, /中文;1/);
      } finally { fromBackup.dispose(); }
    } finally { encoded.dispose(); }
    assert.equal(await readFile(path, 'utf8'), 'name,n\nsaved,1\n');
    await edits[1].undo();
    assert.doesNotMatch((await document.textPage(0, 10)).text, /pasted/);
    await edits[0].undo();
    assert.equal((await document.textPage(0, 10)).count, 2);
    await edits[0].redo(); await edits[1].redo();
    assert.match((await document.textPage(0, 10)).text, /pasted,42/);
    await document.change({ kind: 'moveRow', row: 1, before: 0 });
    assert.equal(edits.length, 3);
    assert.match((await document.textPage(0, 10)).text, /^name,n\npasted,42\nsaved,1/);
    await edits[2].undo(); assert.match((await document.textPage(0, 10)).text, /^name,n\nsaved,1\npasted,42/);
    await edits[2].redo(); assert.match((await document.textPage(0, 10)).text, /^name,n\npasted,42\nsaved,1/);
    await document.change({ kind: 'moveRow', row: 0, before: 1 }); assert.equal(edits.length, 3);
    const backupId = await document.backup(uri(join(directory, 'backup.csv')) as never);
    const restored = await provider.openCustomDocument(uri(path), { backupId });
    try {
      assert.match((await restored.textPage(0, 10)).text, /pasted,42/);
      assert.ok(restored.changes);
      await restored.save();
      assert.equal(restored.changes, 0);
      assert.match(await readFile(path, 'utf8'), /pasted,42/);
    } finally { restored.dispose(); }
    await assert.rejects(document.save(), /changed on disk/);
    await document.revert();
    assert.equal(document.changes, 0);
    assert.match((await document.textPage(0, 10)).text, /pasted,42/);
  } finally { document?.dispose(); delete boundary.csvSaveTestProvider; await rm(directory, { recursive: true, force: true }); }
});

test('Language defaults to English, broadcasts across open editors, persists, and ignores disposed views', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-language-host-'));
  try {
    const host = join(directory, 'host.cjs');
    await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'language-test-vscode', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: vscodeMock + "\nexports.env = {language:'zh-cn'};", loader: 'js' }));
    } }] });
    const { activate } = createRequire(__filename)(host);
    const state = new Map<string, unknown>();
    const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => new URL(`file://${fsPath}`).href });
    const context = {
      subscriptions: [], extensionUri: uri(directory), globalStorageUri: uri(directory),
      globalState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } },
      workspaceState: { get: (_: string, fallback: unknown) => fallback, update: async () => {} }, asAbsolutePath: () => '',
    };
    activate(context);
    const provider = boundary.csvSaveTestProvider as unknown as { resolveCustomEditor(document: unknown, panel: unknown): Promise<void> };
    const attach = async (currentProvider = provider) => {
      const messages: { type: string; language?: string; error?: string }[] = [];
      let receive!: (message: unknown) => Promise<void>, dispose!: () => void;
      const webview = { cspSource: 'test', options: {}, html: '', asWebviewUri: (value: unknown) => value,
        postMessage: async (message: typeof messages[number]) => { messages.push(message); return true; },
        onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; },
      };
      const document = { uri: uri(join(directory, 'data.csv')), notifyChanged() {}, textDraft: undefined, metadata: undefined, lastError: undefined };
      await currentProvider.resolveCustomEditor(document, { webview, onDidDispose: (handler: () => void) => { dispose = handler; } });
      return { messages, send: (message: unknown) => receive(message), dispose: () => dispose() };
    };
    const first = await attach(), second = await attach();
    await first.send({ type: 'ready', id: 1 });
    assert.equal(first.messages.find(message => message.type === 'language')?.language, 'en');
    await first.send({ type: 'language', language: 'zh-CN', id: 2 });
    assert.equal(state.get('language'), 'zh-CN');
    assert.equal(first.messages.filter(message => message.type === 'language').at(-1)?.language, 'zh-CN');
    assert.equal(second.messages.filter(message => message.type === 'language').at(-1)?.language, 'zh-CN');
    const receivedBeforeDispose = second.messages.length; second.dispose();
    await first.send({ type: 'language', language: 'en', id: 3 });
    assert.equal(second.messages.length, receivedBeforeDispose);
    await first.send({ type: 'language', language: 'zh-CN', id: 4 });
    activate(context);
    const reopened = await attach(boundary.csvSaveTestProvider as unknown as typeof provider);
    await reopened.send({ type: 'ready', id: 5 });
    assert.equal(reopened.messages.find(message => message.type === 'language')?.language, 'zh-CN');
    await reopened.send({ type: 'language', language: 'unsupported', id: 6 });
    assert.equal(state.get('language'), 'zh-CN');
    assert.ok(reopened.messages.find(message => message.type === 'response' && message.error));
    first.dispose(); reopened.dispose();
  } finally { delete boundary.csvSaveTestProvider; await rm(directory, { recursive: true, force: true }); }
});

test('Webview clipboard requests use the native host boundary, preserve text, enforce size limits, and report failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-clipboard-host-'));
  const globalBoundary = globalThis as typeof globalThis & { csvClipboardTest?: { text: string; failRead: boolean; failWrite: boolean } };
  globalBoundary.csvClipboardTest = { text: '', failRead: false, failWrite: false };
  try {
    const host = join(directory, 'host.cjs');
    await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'clipboard-test-vscode', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: vscodeMock, loader: 'js' }));
    } }] });
    const { activate } = createRequire(__filename)(host);
    const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => new URL(`file://${fsPath}`).href });
    activate({ subscriptions: [], extensionUri: uri(directory), globalStorageUri: uri(directory),
      globalState: { get: (_: string, fallback: unknown) => fallback, update: async () => {} },
      workspaceState: { get: (_: string, fallback: unknown) => fallback, update: async () => {} }, asAbsolutePath: () => '',
    });
    const provider = boundary.csvSaveTestProvider as unknown as { resolveCustomEditor(document: unknown, panel: unknown): Promise<void> };
    const messages: { type: string; id?: number; result?: unknown; error?: string }[] = [];
    let receive!: (message: unknown) => Promise<void>, dispose!: () => void;
    await provider.resolveCustomEditor({ notifyChanged() {} }, { webview: { cspSource: 'test', options: {}, html: '', asWebviewUri: (value: unknown) => value,
      postMessage: async (message: typeof messages[number]) => { messages.push(message); return true; },
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; },
    }, onDidDispose: (handler: () => void) => { dispose = handler; } });
    const payload = '"line1\nline2"\t"tab\tvalue"\r\n中文 😀\tlast';
    await receive({ id: 1, type: 'clipboardWrite', text: payload });
    assert.equal(globalBoundary.csvClipboardTest.text, payload);
    await receive({ id: 2, type: 'clipboardRead' });
    assert.equal(messages.find(message => message.id === 2)?.result, payload);
    globalBoundary.csvClipboardTest.failWrite = true;
    await receive({ id: 3, type: 'clipboardWrite', text: 'different' });
    assert.equal(globalBoundary.csvClipboardTest.text, payload);
    assert.match(messages.find(message => message.id === 3)?.error ?? '', /write unavailable/);
    globalBoundary.csvClipboardTest.failRead = true;
    await receive({ id: 4, type: 'clipboardRead' });
    assert.match(messages.find(message => message.id === 4)?.error ?? '', /read unavailable/);
    globalBoundary.csvClipboardTest.failWrite = false; globalBoundary.csvClipboardTest.failRead = false;
    await receive({ id: 5, type: 'clipboardWrite', text: 'x'.repeat(8 * 1024 * 1024 + 1) });
    assert.match(messages.find(message => message.id === 5)?.error ?? '', /8 MB/);
    assert.equal(globalBoundary.csvClipboardTest.text, payload);
    globalBoundary.csvClipboardTest.text = 'x'.repeat(8 * 1024 * 1024 + 1);
    await receive({ id: 6, type: 'clipboardRead' });
    assert.match(messages.find(message => message.id === 6)?.error ?? '', /8 MB/);
    dispose();
  } finally { delete boundary.csvSaveTestProvider; delete globalBoundary.csvClipboardTest; await rm(directory, { recursive: true, force: true }); }
});

test('host Save, Save As, Export and Recover preserve content boundaries and require destination confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-export-host-'));
  const globalBoundary = globalThis as typeof globalThis & { csvExportTest?: { target?: string; confirm: boolean; document?: CsvDocument; commands: string[]; holdPrompt?: boolean } };
  globalBoundary.csvExportTest = { confirm: true, commands: [] };
  let document: CsvDocument | undefined;
  let dispose: (() => void) | undefined;
  try {
    const host = join(directory, 'host.cjs'), worker = join(directory, 'worker.cjs');
    const mock = vscodeMock + `
exports.workspace.fs = { stat: uri => require('node:fs/promises').stat(uri.fsPath) };
exports.window.showSaveDialog = async () => globalThis.csvExportTest.target ? exports.Uri.file(globalThis.csvExportTest.target) : undefined;
exports.window.showWarningMessage = () => { throw new Error('Runtime native warning forbidden'); };
exports.window.showInputBox = () => { throw new Error('Runtime native input forbidden'); };
exports.window.showQuickPick = () => { throw new Error('Runtime native picker forbidden'); };
exports.commands.executeCommand = async command => { globalThis.csvExportTest.commands.push(command); if(command === 'workbench.action.files.save') await globalThis.csvSaveTestProvider.saveCustomDocument(globalThis.csvExportTest.document); };
`;
    await Promise.all([
      build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'export-test-vscode', setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: mock, loader: 'js' }));
      } }] }),
      build({ entryPoints: ['src/engine/worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: worker }),
    ]);
    const { activate } = createRequire(__filename)(host);
    const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => new URL(`file://${fsPath}`).href });
    activate({ subscriptions: [], extensionUri: uri(directory), globalStorageUri: uri(directory),
      globalState: { get: (_: string, fallback: unknown) => fallback, update: async () => {} },
      workspaceState: { get: (_: string, fallback: unknown) => fallback, update: async () => {} }, asAbsolutePath: () => worker,
    });
    const provider = boundary.csvSaveTestProvider as unknown as SaveProvider & { resolveCustomEditor(document: CsvDocument, panel: unknown): Promise<void> };
    const path = join(directory, 'input.csv'), original = 'A,B,C\nalpha,x,3\nbeta,y,1\ngamma,z,2\n';
    await writeFile(path, original);
    document = await provider.openCustomDocument(uri(path), {});
    globalBoundary.csvExportTest.document = document;
    let receive!: (message: unknown) => Promise<void>;
    const messages: { type: string; id?: number; result?: unknown; error?: string; prompt?: HostPrompt }[] = [];
    await provider.resolveCustomEditor(document, { webview: { cspSource: 'test', options: {}, html: '', asWebviewUri: (value: unknown) => value,
      postMessage: async (message: typeof messages[number]) => {
        messages.push(message);
        if (message.type === 'prompt' && !globalBoundary.csvExportTest!.holdPrompt) {
          const prompt = message.prompt!, state = globalBoundary.csvExportTest!;
          const value = prompt.kind === 'input' ? state.target ?? null : state.confirm ? prompt.choices?.[0]?.id ?? null : null;
          queueMicrotask(() => { void receive({ id: 1000000 + prompt.id, type: 'promptChoice', promptId: prompt.id, value }); });
        }
        return true;
      },
      onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; },
    }, onDidDispose: (handler: () => void) => { dispose = handler; } });
    let id = 0;
    const send = async (message: object) => { const current = ++id; await receive({ ...message, id: current }); const response = messages.find(item => item.type === 'response' && item.id === current); assert.ok(response); return response; };
    await document.edit({ row: 1, col: 1, value: 'edited' });
    const query = { filters: [{ col: 2, type: 'number', operator: 'gte', value: 2 }], sort: { col: 2, direction: 1, numeric: true } };
    assert.equal((await send({ type: 'query', query })).error, undefined);
    const editEvents: CustomDocumentEditEvent<CsvDocument>[] = [];
    document.onEdit = event => editEvents.push(event);
    const resetsBefore = messages.filter(message => message.type === 'viewReset').length;
    await document.change({ kind: 'renameColumn', col: 0, name: 'New header' });
    assert.deepEqual(document.query, query);
    await editEvents[0].undo();
    assert.equal(document.metadata?.headers[0], 'A');
    assert.deepEqual(document.query, query);
    await editEvents[0].redo(); assert.equal(document.metadata?.headers[0], 'New header');
    await editEvents[0].undo();
    assert.equal(messages.filter(message => message.type === 'viewReset').length, resetsBefore);
    const exported = join(directory, 'export.csv'); await writeFile(exported, 'old export');
    globalBoundary.csvExportTest.target = exported;
    globalBoundary.csvExportTest.confirm = false;
    await send({ type: 'export', columns: [2, 0] }); assert.equal(await readFile(exported, 'utf8'), 'old export');
    globalBoundary.csvExportTest.confirm = true;
    assert.equal((await send({ type: 'export', columns: [2, 0] })).error, undefined);
    assert.equal(await readFile(exported, 'utf8'), 'A,C\ngamma,2\nalpha,3\n');
    assert.equal(await readFile(path, 'utf8'), original); assert.equal(document.changes, 1);
    assert.deepEqual(document.query, query);
    const history = new VersionHistory(join(directory, 'history'));
    assert.equal((await history.list(exported)).length, 1);
    globalBoundary.csvExportTest.target = join(directory, 'copy.csv');
    assert.equal((await send({ type: 'saveAs' })).error, undefined);
    assert.equal(await readFile(globalBoundary.csvExportTest.target, 'utf8'), original.replace('beta,y,1', 'beta,edited,1'));
    assert.equal(document.changes, 1);
    globalBoundary.csvExportTest.target = path;
    assert.match((await send({ type: 'export', columns: [0] })).error ?? '', /different file/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal((await send({ type: 'save' })).error, undefined);
    assert.equal(await readFile(path, 'utf8'), original.replace('beta,y,1', 'beta,edited,1'));
    assert.equal(document.changes, 0); assert.deepEqual(document.query, query);
    assert.equal((await history.list(path)).length, 1);
    await send({ type: 'save' }); assert.equal((await history.list(path)).length, 1);
    assert.equal(messages.some(message => message.type === 'savePrompt'), false);
    const all = (await send({ type: 'versions', scope: 'all' })).result as { versions: { id: string; source: string }[]; totalBytes: number };
    assert.equal(all.versions.length, 2); assert.equal(all.totalBytes, Buffer.byteLength(original) + 10);
    const originalVersion = all.versions.find(version => version.source === path)!;
    globalBoundary.csvExportTest.target = join(directory, 'recovered.csv');
    assert.equal((await send({ type: 'recover', version: originalVersion.id, source: path, saveAs: true })).error, undefined);
    assert.equal(await readFile(globalBoundary.csvExportTest.target, 'utf8'), original);
    assert.equal(await readFile(path, 'utf8'), original.replace('beta,y,1', 'beta,edited,1'));
    globalBoundary.csvExportTest.confirm = false;
    await send({ type: 'clearVersions', scope: 'all' }); assert.equal((await history.listAll()).length, 2);
    globalBoundary.csvExportTest.confirm = true;
    await send({ type: 'clearVersions', scope: 'file' }); assert.equal((await history.list(path)).length, 0); assert.equal((await history.list(exported)).length, 1);
    await send({ type: 'clearVersions', scope: 'all' }); assert.equal((await history.listAll()).length, 0);
    assert.equal(await readFile(path, 'utf8'), original.replace('beta,y,1', 'beta,edited,1'));
    document.metadata = { ...document.metadata!, bytes: 30 * 1024 * 1024 };
    globalBoundary.csvExportTest.confirm = false;
    assert.equal((await send({ type: 'confirmQuery', query })).result, false);
    const scanPrompt = messages.filter(message => message.type === 'prompt').at(-1)?.prompt;
    assert.equal(scanPrompt?.layout, 'actions');
    assert.deepEqual(scanPrompt?.choices, [{ id: 'continue', label: 'Continue' }]);
    assert.deepEqual(document.query, query);
    globalBoundary.csvExportTest.holdPrompt = true;
    const waiting = send({ type: 'confirmQuery', query });
    await new Promise(resolve => setImmediate(resolve));
    dispose?.(); dispose = undefined;
    assert.equal((await waiting).result, false);
    assert.equal(await readFile(path, 'utf8'), original.replace('beta,y,1', 'beta,edited,1'));
  } finally { dispose?.(); document?.dispose(); delete globalBoundary.csvExportTest; delete boundary.csvSaveTestProvider; await rm(directory, { recursive: true, force: true }); }
});
