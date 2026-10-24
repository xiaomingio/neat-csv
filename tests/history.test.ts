/*
Purpose: Verify version retention, file isolation, and recovery-source integrity with real files.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionHistory } from '../src/VersionHistory';

test('Each file retains five complete pre-overwrite versions, isolates identity, and rejects invalid versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-history-'));
  try {
    const history = new VersionHistory(join(directory, 'storage'));
    const source = join(directory, 'input.csv');
    const other = join(directory, 'other.csv');
    for (let i = 0; i < 7; i++) {
      await writeFile(source, `name,n\n"line1\nline2",${i}\n`);
      await history.capture(source, i % 2 === 0);
    }
    const versions = await history.list(source);
    assert.equal(versions.length, 5);
    assert.deepEqual(await history.list(other), []);
    const newest = await history.get(source, versions[0].id);
    assert.equal(await readFile(newest.path, 'utf8'), 'name,n\n"line1\nline2",6\n');
    assert.equal(newest.version.hasHeader, true);
    const oldest = await history.get(source, versions[4].id);
    assert.equal(await readFile(oldest.path, 'utf8'), 'name,n\n"line1\nline2",2\n');
    await assert.rejects(history.get(other, versions[0].id), /no longer available/);
    await assert.rejects(history.get(source, '../input'), /no longer available/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
