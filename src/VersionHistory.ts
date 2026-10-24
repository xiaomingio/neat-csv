/*
Purpose: Retain recoverable disk versions with per-file history, global storage limits and safe cleanup.
*/
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { HistoryVersion, FileFormat } from './protocol';

type StoredVersion = HistoryVersion & { directory: string };
export type VersionHistoryOptions = { limitBytes?: number };

export class VersionHistory {
  static readonly defaultLimitBytes = 500 * 1024 * 1024;
  private static readonly pending = new Map<string, Promise<unknown>>();
  private limitBytes: number;
  constructor(private readonly root: string, options: VersionHistoryOptions = {}) {
    this.limitBytes = this.validateLimit(options.limitBytes ?? VersionHistory.defaultLimitBytes);
  }

  private validateLimit(bytes: number): number {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Choose a positive backup storage limit.');
    return bytes;
  }

  async setLimitBytes(bytes: number): Promise<void> {
    this.validateLimit(bytes);
    await this.serialize(async () => { this.limitBytes = bytes; await this.prune(0); });
  }

  private async prune(reserved: number): Promise<void> {
    const versions = await this.all();
    let total = versions.reduce((sum, version) => sum + version.bytes, reserved);
    for (const version of versions.reverse()) {
      if (total <= this.limitBytes) break;
      await this.remove(version); total -= version.bytes;
    }
  }

  private directory(source: string): string {
    if (source.startsWith('history:')) {
      const key = source.slice(8);
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('This saved version is no longer available.');
      return join(this.root, key);
    }
    return join(this.root, createHash('sha256').update(resolve(source)).digest('hex'));
  }

  private async entries(directory: string): Promise<StoredVersion[]> {
    try {
      const names = await readdir(directory);
      const versions: StoredVersion[] = [];
      for (const name of names.filter(value => /^[a-f0-9-]{36}\.json$/.test(value))) {
        const version = JSON.parse(await readFile(join(directory, name), 'utf8')) as HistoryVersion;
        if (name !== `${version.id}.json` || !Number.isFinite(version.bytes) || version.bytes < 0 || !Number.isFinite(Date.parse(version.created))) continue;
        try { await stat(join(directory, `${version.id}.csv`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        versions.push({ ...version, directory });
      }
      return versions.sort((a, b) => b.created.localeCompare(a.created));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async list(source: string): Promise<HistoryVersion[]> {
    return (await this.entries(this.directory(source))).map(({ directory: _directory, ...version }) => version);
  }

  private async all(): Promise<StoredVersion[]> {
    let directories: string[];
    try { directories = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const groups = await Promise.all(directories.filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name =>
      (await this.entries(join(this.root, name))).map(version => ({ ...version, source: version.source ?? `history:${name}` }))));
    return groups.flat().sort((a, b) => b.created.localeCompare(a.created));
  }

  async listAll(): Promise<HistoryVersion[]> {
    return (await this.all()).map(({ directory: _directory, ...version }) => version);
  }

  async usage(): Promise<number> { return (await this.all()).reduce((sum, version) => sum + version.bytes, 0); }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.root);
    const task = (VersionHistory.pending.get(key) ?? Promise.resolve()).then(operation);
    const settled = task.catch(() => {});
    VersionHistory.pending.set(key, settled);
    void settled.then(() => { if (VersionHistory.pending.get(key) === settled) VersionHistory.pending.delete(key); });
    return task;
  }

  private async remove(version: StoredVersion): Promise<void> {
    await rm(join(version.directory, `${version.id}.json`), { force: true });
    await rm(join(version.directory, `${version.id}.csv`), { force: true });
  }

  clear(source?: string): Promise<void> {
    return this.serialize(async () => {
      const versions = source ? await this.entries(this.directory(source)) : await this.all();
      for (const version of versions) await this.remove(version);
    });
  }

  capture(path: string, hasHeader: boolean, format?: FileFormat): Promise<void> {
    return this.serialize(async () => {
      let bytes: number;
      try { bytes = (await stat(path)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (bytes > this.limitBytes) throw new Error('The file exceeds the backup storage limit. Increase the limit or save without a backup.');
      const directory = this.directory(path);
      await mkdir(directory, { recursive: true });
      const latest = (await this.list(path))[0];
      const created = new Date(Math.max(Date.now(), latest ? Date.parse(latest.created) + 1 : 0)).toISOString();
      const version: HistoryVersion = { id: randomUUID(), created, bytes, hasHeader, source: resolve(path), ...(format ? { format } : {}) };
      await this.prune(bytes);
      const data = join(directory, `${version.id}.csv`);
      const pending = join(directory, `${version.id}.tmp`);
      try {
        await copyFile(path, data);
        if ((await stat(data)).size !== bytes) throw new Error('The file changed while its backup was being created. Try saving again.');
        await writeFile(pending, JSON.stringify(version), { flag: 'wx' });
        await rename(pending, join(directory, `${version.id}.json`));
      } catch (error) {
        await rm(data, { force: true }); await rm(pending, { force: true }); throw error;
      }
      for (const old of (await this.entries(directory)).slice(5)) await this.remove(old);
    });
  }

  async get(source: string, id: string): Promise<{ path: string; version: HistoryVersion }> {
    const version = (await this.list(source)).find(item => item.id === id);
    if (!version) throw new Error('This saved version is no longer available.');
    return { path: join(this.directory(source), `${version.id}.csv`), version };
  }
}
