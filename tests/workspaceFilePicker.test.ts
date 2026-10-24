/*
Purpose: Verify project folder navigation and destination safety through the real VS Code picker boundary.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

type PickerState = { roots: string[]; system?: string; folders: string[] };
const boundary = globalThis as typeof globalThis & { csvPickerTest: PickerState };
const mock = `
const fs = require('node:fs/promises'); const path = require('node:path');
const state = () => globalThis.csvPickerTest;
exports.Uri = { file: value => ({ fsPath: value, scheme: 'file', toString: () => 'file://' + value }), joinPath: (uri, ...parts) => exports.Uri.file(path.join(uri.fsPath,...parts)) };
exports.CancellationError = class CancellationError extends Error { constructor() { super('Canceled'); this.name = 'CancellationError'; } };
exports.FileType = { Directory: 2, File: 1 };
exports.workspace = { get workspaceFolders() { return state().roots.map((root, i) => ({ name:'Project ' + i, uri:exports.Uri.file(root) })); },
 getWorkspaceFolder: uri => exports.workspace.workspaceFolders.find(root => uri.fsPath.startsWith(root.uri.fsPath + '/')),
 fs: { readDirectory: async uri => { state().folders.push(uri.fsPath); return (await fs.readdir(uri.fsPath,{withFileTypes:true})).map(item => [item.name,item.isDirectory()?2:1]); }, stat: uri => fs.stat(uri.fsPath) } };
exports.window = {
 showQuickPick: () => { throw new Error('Native picker forbidden'); },
 showInputBox: () => { throw new Error('Native input forbidden'); },
 showWarningMessage: () => { throw new Error('Native warning forbidden'); },
 showSaveDialog: async () => state().system ? exports.Uri.file(state().system) : undefined
};
`;

test('project destination picker navigates roots and folders, validates names, confirms replacement and supports cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-picker-'));
  try {
    const host = join(directory, 'picker.cjs');
    await build({ entryPoints: ['src/WorkspaceFilePicker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'picker-vscode-boundary', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: mock, loader: 'js' }));
    } }] });
    const { WorkspaceFilePicker } = createRequire(__filename)(host);
    const prompts: import('../src/EditorUi').EditorPrompt[] = [];
    let answers: import('../src/protocol').PromptValue[] = [];
    const picker = new WorkspaceFilePicker({ prompt: async (options: import('../src/EditorUi').EditorPrompt) => { prompts.push(options); return answers.shift() ?? null; } });
    const root = join(directory, 'project'), second = join(directory, 'other'), nested = join(root, 'data');
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(second)]);
    const source = { fsPath: join(nested, 'input.csv'), scheme: 'file', toString: () => `file://${join(nested, 'input.csv')}` };
    const reset = (values: import('../src/protocol').PromptValue[] = [], options: Partial<PickerState> = {}) => { answers = values; prompts.length = 0; boundary.csvPickerTest = { roots: [root, second], folders: [], ...options }; };
    reset(['save', 'view.csv']);
    await picker.pick(source, 'export');
    assert.match(prompts[0].message ?? '', /filtered rows.*sort order/);
    assert.match(prompts[0].message ?? '', /Hidden columns.*omitted/);
    assert.match(prompts[0].message ?? '', /original file.*unchanged/);
    reset([join(directory, 'outside.csv')], { roots: [] });
    await picker.pick(source, 'export');
    assert.match(prompts[0].detail ?? '', /Pinning is not saved/);
    reset(['save', 'new.csv']);
    assert.equal((await picker.pick(source, 'saveAs')).fsPath, join(nested, 'new.csv'));
    assert.deepEqual(boundary.csvPickerTest.folders, [nested]);
    assert.equal(prompts[1].value, 'input.copy.csv');
    for (const name of ['', '..', '../escape.csv', 'folder/file.csv', 'folder\\file.csv']) {
      reset(['save', name, 'valid.csv']);
      assert.equal((await picker.pick(source, 'saveAs')).fsPath, join(nested, 'valid.csv'));
      assert.ok(prompts[2].validationMessage);
    }
    reset(['parent', 'roots', '1', 'save', 'new.csv']);
    assert.equal((await picker.pick(source, 'export')).fsPath, join(second, 'new.csv'));
    assert.equal(prompts.at(-1)?.value, 'input.view.csv');
    reset(); assert.equal(await picker.pick(source, 'saveAs'), undefined);
    reset(['save']); assert.equal(await picker.pick(source, 'saveAs'), undefined);
    await writeFile(join(nested, 'new.csv'), 'existing');
    reset(['save', 'new.csv']); assert.equal(await picker.pick(source, 'saveAs'), undefined);
    reset(['save', 'new.csv', 'replace']); assert.equal((await picker.pick(source, 'saveAs')).fsPath, join(nested, 'new.csv'));
    reset(['save', 'input.csv']); await assert.rejects(picker.pick(source, 'saveAs'), /different file/);
    reset(['relative.csv', join(directory, 'outside.csv')], { roots: [] });
    assert.equal((await picker.pick(source, 'export')).fsPath, join(directory, 'outside.csv'));
    assert.ok(prompts[1].validationMessage);
    reset(['chooseSystemLocation'], { roots: [], system: join(directory, 'system.csv') });
    assert.equal((await picker.pick(source, 'export')).fsPath, join(directory, 'system.csv'));
    reset(['system'], { system: join(directory, 'system.csv') });
    assert.equal((await picker.pick(source, 'recover')).fsPath, join(directory, 'system.csv'));
    reset(); assert.equal(await picker.outputEncoding('utf8'), 'utf8');
    reset(['utf8']); assert.equal(await picker.outputEncoding('gb18030'), 'utf8');
    reset(['original']); assert.equal(await picker.outputEncoding('gb18030'), 'gb18030');
    reset(); assert.equal(await picker.outputEncoding('gb18030'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Read-only destinations require explicit overwrite consent or Save As and preserve the source on cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-save-target-'));
  try {
    const host = join(directory, 'target.cjs');
    await build({ entryPoints: ['src/SaveTarget.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'target-vscode-boundary', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: mock, loader: 'js' }));
    } }] });
    const { SaveTarget } = createRequire(__filename)(host);
    const prompts: import('../src/EditorUi').EditorPrompt[] = [];
    let answers: import('../src/protocol').PromptValue[] = [];
    const policy = new SaveTarget({ prompt: async (prompt: import('../src/EditorUi').EditorPrompt) => { prompts.push(prompt); return answers.shift() ?? null; } });
    boundary.csvPickerTest = { roots: [], folders: [] };
    const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` });
    const source = uri(join(directory, 'ordinary.csv'));
    await writeFile(source.fsPath, 'A\noriginal\n');
    assert.equal(await policy.choose(source, source), source); assert.equal(prompts.length, 0);
    await chmod(source.fsPath, 0o444);
    await assert.rejects(policy.choose(source, source), { name: 'CancellationError' });
    assert.deepEqual(prompts[0].choices?.map(choice => choice.id), ['saveAs', 'overwrite']);
    answers = ['overwrite']; assert.equal(await policy.choose(source, source), source);
    const copy = join(directory, 'copy.csv'); answers = ['saveAs', copy];
    assert.equal((await policy.choose(source, source)).fsPath, copy);
    assert.equal(await readFile(source.fsPath, 'utf8'), 'A\noriginal\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
