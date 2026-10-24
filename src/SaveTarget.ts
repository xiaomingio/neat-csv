/*
Choose protected save destinations and require explicit consent before replacing read-only files.
*/
import * as vscode from 'vscode';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { WorkspaceFilePicker } from './WorkspaceFilePicker';
import { t } from './Locale';
import type { EditorUi } from './EditorUi';

export class SaveTarget {
  constructor(private readonly ui: EditorUi) {}

  async choose(source: vscode.Uri, initial: vscode.Uri): Promise<vscode.Uri> {
    let target = initial;
    const picker = new WorkspaceFilePicker(this.ui);
    for (;;) {
      let readOnly = false;
      try {
        const info = await stat(target.fsPath);
        readOnly = (info.mode & 0o222) === 0;
        if (!readOnly) try { await access(target.fsPath, constants.W_OK); } catch { readOnly = true; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!readOnly) return target;
      const choice = await this.ui.prompt({ kind: 'choice', layout: 'actions',
        title: t('This file is read-only.'),
        detail: t('Choose Save As to keep a separate copy, or Force overwrite to replace this read-only file. Backup settings and file-change checks still apply.'),
        choices: [{ id: 'saveAs', label: t('Save As…') }, { id: 'overwrite', label: t('Force overwrite') }],
      });
      if (choice === 'overwrite') return target;
      if (choice !== 'saveAs') throw new vscode.CancellationError();
      const selected = await picker.pick(source, 'saveAs');
      if (!selected) throw new vscode.CancellationError();
      target = selected;
    }
  }
}
