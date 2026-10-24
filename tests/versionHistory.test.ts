/*
File purpose: Verify global version discovery, legacy recovery, disk retention, and scoped cleanup against real storage.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { VersionHistory } from '../src/VersionHistory';

test('Global histories retain source identity and exact usage while cleanup only removes selected saved versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-version-global-'));
  try {
    const root = join(directory, 'storage'), history = new VersionHistory(root);
    const first = join(directory, 'first.csv'), second = join(directory, 'second.csv');
    const firstText = 'name,n\n"line1\nline2",1\n', secondText = 'a;b\r\n中文;2';
    await writeFile(first, firstText); await writeFile(second, secondText);
    await history.capture(first, true, { encoding: 'utf8', delimiter: ',' });
    await history.capture(second, false, { encoding: 'gbk', delimiter: ';' });
    const versions = await history.listAll();
    assert.deepEqual(versions.map(version => version.source).sort(), [first, second]);
    assert.equal(await history.usage(), Buffer.byteLength(firstText) + Buffer.byteLength(secondText));
    const firstVersion = versions.find(version => version.source === first)!;
    assert.deepEqual(firstVersion.format, { encoding: 'utf8', delimiter: ',' });
    const secondVersion = await history.get(second, versions.find(version => version.source === second)!.id);
    assert.equal(secondVersion.version.hasHeader, false);
    assert.equal(await readFile(secondVersion.path, 'utf8'), secondText);
    const checkpoint = join(directory, 'working-checkpoint.csv'), stray = join(root, 'unrelated', 'keep.csv');
    await mkdir(dirname(stray), { recursive: true });
    await writeFile(checkpoint, 'unsaved working data'); await writeFile(stray, 'external file');
    await writeFile(join(root, 'keep.txt'), 'storage metadata');
    await history.clear(first);
    assert.deepEqual(await history.list(first), []);
    await assert.rejects(history.get(first, firstVersion.id), /no longer available/);
    assert.equal((await history.listAll()).length, 1);
    assert.equal(await history.usage(), Buffer.byteLength(secondText));
    assert.equal(await readFile(first, 'utf8'), firstText); assert.equal(await readFile(second, 'utf8'), secondText);
    await history.clear(); await history.clear();
    assert.deepEqual(await history.listAll(), []); assert.equal(await history.usage(), 0);
    assert.equal(await readFile(checkpoint, 'utf8'), 'unsaved working data');
    assert.equal(await readFile(stray, 'utf8'), 'external file');
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'storage metadata');
    assert.equal(await readFile(first, 'utf8'), firstText); assert.equal(await readFile(second, 'utf8'), secondText);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Legacy manifests remain recoverable by opaque history identity when their original source path is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-version-legacy-'));
  try {
    const history = new VersionHistory(join(directory, 'storage')), source = join(directory, 'old-location.csv');
    await writeFile(source, 'a,b\nlegacy,1'); await history.capture(source, true);
    const version = (await history.list(source))[0], snapshot = await history.get(source, version.id);
    const manifest = join(dirname(snapshot.path), `${version.id}.json`);
    const { source: _source, ...legacy } = version;
    await writeFile(manifest, JSON.stringify(legacy)); await rm(source);
    const all = await history.listAll(), identity = all[0].source!;
    assert.equal(all.length, 1); assert.match(identity, /^history:[a-f0-9]{64}$/);
    assert.equal(basename(dirname(snapshot.path)), identity.slice(8));
    assert.equal(await history.usage(), Buffer.byteLength('a,b\nlegacy,1'));
    assert.equal(await readFile((await history.get(identity, version.id)).path, 'utf8'), 'a,b\nlegacy,1');
    for (const token of ['history:../', 'history:' + '../'.repeat(22), 'history:' + 'A'.repeat(64), 'history:' + '0'.repeat(63)]) {
      await assert.rejects(history.list(token), /no longer available/);
      await assert.rejects(history.get(token, version.id), /no longer available/);
      await assert.rejects(history.clear(token), /no longer available/);
    }
    assert.equal((await history.listAll()).length, 1);
    await history.clear(identity); assert.deepEqual(await history.listAll(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Configured storage limits evict oldest versions and reject oversized snapshots without an exception', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-version-budget-'));
  try {
    const history = new VersionHistory(join(directory, 'storage'), { limitBytes: 12 });
    const oldSource = join(directory, 'large.csv'), recentSource = join(directory, 'recent.csv');
    await writeFile(oldSource, 'old data'); await history.capture(oldSource, true);
    const old = (await history.list(oldSource))[0], snapshot = await history.get(oldSource, old.id);
    await writeFile(recentSource, 'newest data'); await history.capture(recentSource, false);
    assert.deepEqual(await history.list(oldSource), []);
    await assert.rejects(readFile(snapshot.path), { code: 'ENOENT' });
    const current = await history.list(recentSource);
    assert.equal(current.length, 1); assert.equal(await history.usage(), Buffer.byteLength('newest data'));
    assert.equal(await readFile((await history.get(recentSource, current[0].id)).path, 'utf8'), 'newest data');
    assert.equal(await readFile(oldSource, 'utf8'), 'old data');
    await writeFile(oldSource, 'too large now');
    await assert.rejects(history.capture(oldSource, true), /exceeds the backup storage limit/);
    assert.equal((await history.listAll()).length, 1); assert.equal(await history.usage(), 11);
    await history.setLimitBytes(10); assert.equal(await history.usage(), 0);
    await assert.rejects(history.setLimitBytes(0), /positive backup storage limit/);
    await history.setLimitBytes(20); await history.capture(oldSource, true);
    assert.equal(await history.usage(), 13);
    assert.equal(await readFile((await history.get(oldSource, (await history.list(oldSource))[0].id)).path, 'utf8'), 'too large now');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Default budget rejects a larger sparse source before copying and shared storage serializes concurrent captures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-version-default-'));
  try {
    const root = join(directory, 'storage'), history = new VersionHistory(root), source = join(directory, 'large.csv');
    const handle = await open(source, 'wx');
    try { await handle.truncate(VersionHistory.defaultLimitBytes + 1); } finally { await handle.close(); }
    await assert.rejects(history.capture(source, true), /exceeds the backup storage limit/);
    assert.deepEqual(await history.listAll(), []); assert.equal(await history.usage(), 0);
    const first = join(directory, 'first.csv'), second = join(directory, 'second.csv');
    await writeFile(first, 'abcdefghijkl'); await writeFile(second, 'mnopqrstuvwx');
    const one = new VersionHistory(root, { limitBytes: 20 }), two = new VersionHistory(root, { limitBytes: 20 });
    await Promise.all([one.capture(first, true), two.capture(second, true)]);
    assert.equal(await one.usage(), 12); assert.equal((await one.listAll()).length, 1);
    assert.equal(await readFile((await two.get(second, (await two.list(second))[0].id)).path, 'utf8'), 'mnopqrstuvwx');
    assert.equal(await readFile(first, 'utf8'), 'abcdefghijkl');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
