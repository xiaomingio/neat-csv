/*
File purpose: Verify backup consent, storage-limit updates, and cancellation at the editor prompt boundary using real files.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { EditorPrompt } from '../src/EditorUi';
import type { PromptValue } from '../src/protocol';
import type { BackupPolicy } from '../src/BackupPolicy';
import { VersionHistory } from '../src/VersionHistory';

type BoundaryState = {
  settings: Record<string, unknown>;
  answers: PromptValue[];
  failUpdate?: boolean;
  prompts: EditorPrompt[];
  updates: { key: string; value: unknown; target: number }[];
};
const boundary = globalThis as typeof globalThis & { csvBackupPolicyTest?: BoundaryState };

async function fixture(run: (value: { directory: string; policy: BackupPolicy; history: VersionHistory; state: BoundaryState; source: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'csv-backup-policy-'));
  const state: BoundaryState = { settings: {}, prompts: [], answers: [], updates: [] };
  boundary.csvBackupPolicyTest = state;
  try {
    const host = join(directory, 'policy.cjs');
    await build({ entryPoints: ['src/BackupPolicy.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: host, plugins: [{ name: 'backup-policy-vscode', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ loader: 'js', contents: `
exports.CancellationError = class CancellationError extends Error { constructor(){ super('Canceled'); this.name='CancellationError'; } };
exports.ConfigurationTarget = { Global: 1 };
exports.workspace = { getConfiguration: () => ({
  get: (key, fallback) => globalThis.csvBackupPolicyTest.settings[key] ?? fallback,
  update: async (key, value, target) => { const state=globalThis.csvBackupPolicyTest; if(state.failUpdate) throw new Error('Settings unavailable'); state.updates.push({key,value,target}); state.settings[key]=value; },
}) };
exports.window = new Proxy({}, { get: () => () => { throw new Error('Native prompts are forbidden'); } });
` }));
    } }] });
    const { BackupPolicy: Policy } = createRequire(__filename)(host) as { BackupPolicy: typeof BackupPolicy };
    const history = new VersionHistory(join(directory, 'history'));
    const source = join(directory, 'input.csv'); await writeFile(source, 'a,b\nsource,1');
    await run({ directory, state, source, history, policy: new Policy(history, { prompt: async prompt => { state.prompts.push(prompt); return state.answers.shift() ?? null; } }) });
  } finally { delete boundary.csvBackupPolicyTest; await rm(directory, { recursive: true, force: true }); }
}
const target = (path: string) => ({ fsPath: path }) as never;

test('Small saves use backups automatically, disabled backups bypass prompts, and new paths need no consent', async () => {
  await fixture(async ({ directory, state, policy, history, source }) => {
    assert.equal(await policy.forTarget(target(source)), history); assert.equal(state.prompts.length, 0);
    assert.equal(await policy.forTarget(target(join(directory, 'new.csv'))), history);
    state.settings = { enabled: false, maxStorageMB: 1, largeFileWarningMB: 0 };
    assert.equal(await policy.forTarget(target(source)), undefined); assert.equal(state.prompts.length, 0);
    assert.equal(await readFile(source, 'utf8'), 'a,b\nsource,1'); assert.equal(await history.usage(), 0);
  });
});

test('Large-file warnings require explicit backup or skip consent and cancellation preserves the source', async () => {
  await fixture(async ({ state, policy, history, source }) => {
    state.settings = { maxStorageMB: 1, largeFileWarningMB: 0 };
    await assert.rejects(policy.forTarget(target(source)), { name: 'CancellationError' });
    assert.equal(await history.usage(), 0);
    state.answers.push('skip');
    assert.equal(await policy.forTarget(target(source)), undefined);
    assert.equal(await history.usage(), 0);
    state.answers.push('backup');
    const approved = await policy.forTarget(target(source)); assert.equal(approved, history);
    await approved!.capture(source, true);
    const version = (await history.list(source))[0];
    assert.equal(await readFile((await history.get(source, version.id)).path, 'utf8'), 'a,b\nsource,1');
    assert.equal(await readFile(source, 'utf8'), 'a,b\nsource,1');
    assert.equal(state.prompts.length, 3);
    assert.equal(state.prompts.filter(prompt => prompt.kind === 'input').length, 0); assert.equal(state.updates.length, 0);
  });
});

test('Over-budget saves can skip or cancel and only a validated persisted increase enables the larger backup', async () => {
  await fixture(async ({ state, policy, history, source }) => {
    const bytes = 1024 * 1024 + 1;
    const file = await open(source, 'r+'); try { await file.truncate(bytes); } finally { await file.close(); }
    state.settings = { maxStorageMB: 1, largeFileWarningMB: 0 };
    await assert.rejects(policy.forTarget(target(source)), { name: 'CancellationError' });
    state.answers.push('skip'); assert.equal(await policy.forTarget(target(source)), undefined);
    state.answers.push('increase'); await assert.rejects(policy.forTarget(target(source)), { name: 'CancellationError' });
    assert.equal(state.updates.length, 0); assert.equal(await history.usage(), 0);
    state.answers.push('increase', '1', '0', '-2', '2.5', 'abc', '9007199254740992', '2');
    const approved = await policy.forTarget(target(source)); assert.equal(approved, history);
    assert.ok(state.prompts.some(prompt => prompt.kind === 'input' && prompt.validationMessage));
    assert.deepEqual(state.updates, [{ key: 'maxStorageMB', value: 2, target: 1 }]);
    await approved!.capture(source, true); assert.equal(await history.usage(), bytes);
    assert.equal((await readFile(source)).subarray(0, 12).toString(), 'a,b\nsource,1');
  });
});

test('Storage configuration failures block backup approval and configured limits reach real history retention', async () => {
  await fixture(async ({ state, policy, history, source, directory }) => {
    const old = join(directory, 'old.csv');
    const oldFile = await open(old, 'wx'); try { await oldFile.truncate(1024 * 1024 + 1); } finally { await oldFile.close(); }
    await history.capture(old, true);
    state.settings = { maxStorageMB: 1, largeFileWarningMB: 50 };
    assert.equal(await policy.forTarget(target(source)), history);
    assert.equal(await history.usage(), 0); assert.deepEqual(await history.list(old), []);
    state.answers.push('increase', '2'); state.failUpdate = true;
    await assert.rejects(policy.forTarget(target(old)), /Settings unavailable/);
    assert.equal(state.updates.length, 0);
    await assert.rejects(history.capture(old, true), /exceeds the backup storage limit/);
    assert.equal(await history.usage(), 0);
    assert.equal(await readFile(source, 'utf8'), 'a,b\nsource,1');
  });
});


test('Backup settings are edited together, validate on host, cancel without changes, and enforce the real budget', async () => {
  await fixture(async ({ state, policy, history, source, directory }) => {
    await policy.settings(); assert.equal(state.updates.length, 0);
    const old = join(directory, 'old.csv');
    const file = await open(old, 'wx'); try { await file.truncate(1024 * 1024 + 1); } finally { await file.close(); }
    await history.capture(old, true);
    state.answers.push({ enabled: false, maxStorageMB: '0', largeFileWarningMB: '-1' }, { enabled: false, maxStorageMB: '1', largeFileWarningMB: '0' });
    await policy.settings();
    assert.deepEqual(state.settings, { enabled: false, maxStorageMB: 1, largeFileWarningMB: 0 });
    assert.equal(state.updates.length, 3);
    assert.equal(await history.usage(), 0);
    assert.ok(state.prompts.at(-1)!.validationMessage);
    assert.equal(state.prompts.at(-1)!.fields!.length, 3);
    assert.equal(await policy.forTarget(target(source)), undefined);
  });
});
