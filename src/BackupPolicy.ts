/*
Purpose: Apply backup budgets and collect overwrite consent through editor-owned prompts.
*/
import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';
import { VersionHistory } from './VersionHistory';
import type { EditorUi } from './EditorUi';
import { t } from './Locale';

const MB = 1024 * 1024;
const validMB = (value: string, minimum: number) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value) * MB) && Number(value) >= minimum;

export class BackupPolicy {
  constructor(private readonly history: VersionHistory, private readonly ui: EditorUi) {}

  async settings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('vscode-csv.backup');
    let values: Record<string, string | boolean> = { enabled: config.get('enabled', true), maxStorageMB: String(config.get('maxStorageMB', 500)), largeFileWarningMB: String(config.get('largeFileWarningMB', 50)) };
    let validationMessage: string | undefined;
    for (;;) {
      const result = await this.ui.prompt({ kind: 'form', title: t('Backup settings'), confirmLabel: t('Apply'), validationMessage, fields: [
        { id: 'enabled', type: 'checkbox', label: t('Keep recovery versions'), value: values.enabled },
        { id: 'maxStorageMB', type: 'number', label: t('Backup storage limit (MB)'), value: values.maxStorageMB, min: 1, required: true },
        { id: 'largeFileWarningMB', type: 'number', label: t('Large-file warning threshold (MB)'), value: values.largeFileWarningMB, min: 0, required: true },
      ] });
      if (result === null) return;
      if (typeof result !== 'object') { validationMessage = t('Enter valid backup settings.'); continue; }
      values = result;
      if (typeof result.enabled !== 'boolean' || typeof result.maxStorageMB !== 'string' || !validMB(result.maxStorageMB, 1) || typeof result.largeFileWarningMB !== 'string' || !validMB(result.largeFileWarningMB, 0)) { validationMessage = t('Enter valid backup settings.'); continue; }
      const updates = { enabled: result.enabled, maxStorageMB: Number(result.maxStorageMB), largeFileWarningMB: Number(result.largeFileWarningMB) };
      for (const [key, value] of Object.entries(updates)) if (config.get(key, key === 'enabled' ? true : key === 'maxStorageMB' ? 500 : 50) !== value) await config.update(key, value, vscode.ConfigurationTarget.Global);
      await this.history.setLimitBytes(updates.maxStorageMB * MB);
      return;
    }
  }

  async forTarget(target: vscode.Uri): Promise<VersionHistory | undefined> {
    const settings = vscode.workspace.getConfiguration('vscode-csv.backup');
    if (settings.get<boolean>('enabled', true) === false) return;
    let bytes: number;
    try { bytes = (await stat(target.fsPath)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.history; throw error; }
    let limitMB = settings.get<number>('maxStorageMB', 500);
    const warningMB = settings.get<number>('largeFileWarningMB', 50);
    const skip = { id: 'skip', label: t('Save without backup') };
    if (bytes > limitMB * MB) {
      const choice = await this.ui.prompt({ kind: 'choice', layout: 'actions', title: t('This file is larger than the backup storage limit.'), detail: t('Increase the limit to keep a recovery version, or explicitly save without a backup.'), choices: [{ id: 'increase', label: t('Increase limit') }, skip] });
      if (choice === 'skip') return;
      if (choice !== 'increase') throw new vscode.CancellationError();
      const minimum = Math.ceil(bytes / MB);
      let value = String(Math.max(minimum, limitMB));
      let validationMessage: string | undefined;
      for (;;) {
        const result = await this.ui.prompt({ kind: 'input', title: t('Backup storage limit (MB)'), value, input: { kind: 'number', min: minimum }, validationMessage });
        if (result === null) throw new vscode.CancellationError();
        if (typeof result === 'string' && validMB(result, minimum)) { limitMB = Number(result); break; }
        if (typeof result === 'string') value = result;
        validationMessage = t('Enter a limit large enough for this file.');
      }
      await settings.update('maxStorageMB', limitMB, vscode.ConfigurationTarget.Global);
    } else if (bytes > warningMB * MB) {
      const choice = await this.ui.prompt({ kind: 'choice', layout: 'actions', title: t('Create a backup before saving this large file?'), detail: t('A backup uses additional disk space. Older saved versions are removed automatically within your storage limit.'), choices: [{ id: 'backup', label: t('Back up and save') }, skip] });
      if (choice === 'skip') return;
      if (choice !== 'backup') throw new vscode.CancellationError();
    }
    await this.history.setLimitBytes(limitMB * MB);
    return this.history;
  }
}
