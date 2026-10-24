/*
Purpose: Choose CSV destinations inside the editor, using native file selection only when explicitly requested.
*/
import * as vscode from 'vscode';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { t } from './Locale';
import type { EditorUi } from './EditorUi';

type FolderItem = { id: string; label: string; description?: string; action: 'save' | 'parent' | 'roots' | 'folder' | 'system'; uri?: vscode.Uri };

export class WorkspaceFilePicker {
  constructor(private readonly ui: EditorUi) {}

  async pick(source: vscode.Uri, purpose: 'saveAs' | 'export' | 'recover'): Promise<vscode.Uri | undefined> {
    const extension = extname(source.fsPath) || '.csv';
    const name = `${basename(source.fsPath, extname(source.fsPath))}.${purpose === 'export' ? 'view' : purpose === 'recover' ? 'recovered' : 'copy'}${extension}`;
    const title = t(purpose === 'export' ? 'Export current view' : purpose === 'recover' ? 'Recover CSV' : 'Save CSV as');
    const explanation = purpose === 'export' ? t('Export the currently filtered rows in their current sort order, including edited values and visible columns in document order. Hidden columns and filtered-out rows are omitted. Pinning is not saved. Choose a separate file; the original file and its unsaved changes stay unchanged.') : undefined;
    const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    let target: vscode.Uri | undefined;
    if (!roots.length) {
      const path = await this.path(join(dirname(source.fsPath), name), title, explanation);
      if (path === 'chooseSystemLocation') target = await this.system(vscode.Uri.file(dirname(source.fsPath)), name);
      else if (path !== null) target = vscode.Uri.file(path);
    } else {
      let root = vscode.workspace.getWorkspaceFolder(source) ?? roots[0];
      let folder = vscode.workspace.getWorkspaceFolder(source) ? vscode.Uri.file(dirname(source.fsPath)) : root.uri;
      for (;;) {
        const children = await vscode.workspace.fs.readDirectory(folder);
        const items: FolderItem[] = [{ id: 'save', label: t('Save in this folder'), description: folder.fsPath, action: 'save' }];
        if (folder.toString() !== root.uri.toString()) items.push({ id: 'parent', label: '..', action: 'parent' });
        if (roots.length > 1) items.push({ id: 'roots', label: t('Workspace folders…'), action: 'roots' });
        items.push(...children.filter(([, type]) => type & vscode.FileType.Directory).sort(([a], [b]) => a.localeCompare(b)).map(([child], index) => ({ id: `folder:${index}`, label: child, action: 'folder' as const, uri: vscode.Uri.joinPath(folder, child) })));
        items.push({ id: 'system', label: t('Choose another location…'), action: 'system' });
        const choice = await this.ui.prompt({ kind: 'choice', title, message: explanation, detail: folder.fsPath, choices: items.map(({ id, label, description }) => ({ id, label, description })) });
        const selected = items.find(item => item.id === choice);
        if (!selected) return;
        if (selected.action === 'folder') folder = selected.uri!;
        else if (selected.action === 'parent') folder = vscode.Uri.file(dirname(folder.fsPath));
        else if (selected.action === 'roots') {
          const choice = await this.ui.prompt({ kind: 'choice', title: t('Workspace folders…'), choices: roots.map((item, index) => ({ id: String(index), label: item.name, description: item.uri.fsPath })) });
          if (typeof choice !== 'string') return;
          const selectedRoot = roots.find((_, index) => String(index) === choice);
          if (!selectedRoot) return;
          root = selectedRoot; folder = root.uri;
        } else if (selected.action === 'system') { target = await this.system(folder, name); break; }
        else {
          const filename = await this.filename(name);
          if (filename === null) return;
          target = vscode.Uri.joinPath(folder, filename); break;
        }
      }
    }
    if (!target) return;
    if (target.toString() === source.toString()) throw new Error(t(purpose === 'export' ? 'Choose a different file for exporting the current view.' : purpose === 'recover' ? 'Choose a different file, or select Overwrite in Recover.' : 'Choose a different file for Save As, or use Save.'));
    try { await vscode.workspace.fs.stat(target); }
    catch (error) {
      if ((error as { code?: string }).code === 'FileNotFound' || (error as { code?: string }).code === 'ENOENT') return target;
      throw error;
    }
    return await this.ui.prompt({ kind: 'choice', layout: 'actions', title: t('Replace the existing file?'), detail: target.fsPath, choices: [{ id: 'replace', label: t('Replace') }] }) === 'replace' ? target : undefined;
  }

  private async filename(initial: string): Promise<string | null> {
    let value = initial, validationMessage: string | undefined;
    for (;;) {
      const result = await this.ui.prompt({ kind: 'input', title: t('File name'), value, validationMessage, input: { kind: 'text' } });
      if (typeof result !== 'string') return null;
      if (result.trim() && result !== '.' && result !== '..' && !/[/\\\0]/.test(result)) return result;
      value = result; validationMessage = t('Enter a file name without folder separators.');
    }
  }

  private async path(initial: string, title: string, explanation?: string): Promise<string | null> {
    let value = initial, validationMessage: string | undefined;
    for (;;) {
      const result = await this.ui.prompt({ kind: 'input', title, message: t('File path'), detail: explanation, value, input: { kind: 'text' }, validationMessage,
        choices: [{ id: 'chooseSystemLocation', label: t('Choose another location…') }] });
      if (typeof result !== 'string') return null;
      if (result === 'chooseSystemLocation') return result;
      if (isAbsolute(result) && !result.includes('\0') && !/[\\/]$/.test(result) && !['.', '..'].includes(basename(result))) return result;
      value = result; validationMessage = t('Enter an absolute file path including the file name.');
    }
  }

  async outputEncoding(encoding: string): Promise<string | undefined> {
    if (/^utf-?8$/i.test(encoding)) return encoding;
    const selected = await this.ui.prompt({ kind: 'choice', title: t('Output encoding'), message: t('Choose the encoding for this copy.'), choices: [
      { id: 'original', label: t('Keep original encoding ({encoding})', { encoding }) },
      { id: 'utf8', label: 'UTF-8' },
    ] });
    return selected === 'original' ? encoding : selected === 'utf8' ? 'utf8' : undefined;
  }

  private system(folder: vscode.Uri, name: string): Thenable<vscode.Uri | undefined> {
    return vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), filters: { 'CSV / TSV': ['csv', 'tsv'] } });
  }
}
