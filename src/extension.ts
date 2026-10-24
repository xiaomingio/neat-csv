/*
File purpose: Register the CSV editor, native document lifecycle, and webview message handlers.
*/
import * as vscode from 'vscode';
import { copyFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { VersionHistory } from './VersionHistory';
import { randomBytes } from 'node:crypto';
import { CsvDocument } from './CsvDocument';
import { WorkspaceFilePicker } from './WorkspaceFilePicker';
import { confirmQuery } from './QueryConfirmation';
import { BackupPolicy } from './BackupPolicy';
import { WebviewPrompts, type EditorUi } from './EditorUi';
import { SaveTarget } from './SaveTarget';
import { locale, t, type Language } from './Locale';
import type { ClientMessage, HostMessage, SaveDecision, FileFormat, SaveOptions } from './protocol';

class CsvEditorProvider implements vscode.CustomEditorProvider<CsvDocument> {
  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CsvDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  private readonly history: VersionHistory;
  private readonly prompts = new Map<CsvDocument, WebviewPrompts>();
  private readonly webviews = new Set<vscode.Webview>();
  constructor(private readonly context: vscode.ExtensionContext) {
    this.history = new VersionHistory(vscode.Uri.joinPath(context.globalStorageUri, 'history').fsPath);
    const savedLanguage = context.globalState.get<Language>('language', 'en');
    locale.setLanguage(savedLanguage === 'zh-CN' ? 'zh-CN' : 'en');
  }

  private editorUi(document: CsvDocument): EditorUi {
    return { prompt: options => this.prompts.get(document)?.prompt(options) ?? Promise.resolve(null) };
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<CsvDocument> {
    const worker = this.context.asAbsolutePath('dist/worker.js');
    const hasHeader = this.context.workspaceState.get<boolean>(`header:${uri.toString()}`, true);
    let format = this.context.workspaceState.get<FileFormat>(`format:${uri.toString()}`);
    let document: CsvDocument;
    try { document = await CsvDocument.open(uri, worker, openContext.backupId, hasHeader, format); }
    catch (error) {
      if (openContext.backupId || !/UTF-?8|encoding/i.test(String(error))) throw error;
      const choice = await vscode.window.showQuickPick([
        { label: t('GB18030 / GBK'), encoding: 'gb18030' }, { label: t('Windows-1252'), encoding: 'windows-1252' },
        { label: t('UTF-16 LE'), encoding: 'utf-16le' }, { label: t('UTF-16 BE'), encoding: 'utf-16be' },
        { label: t('Shift JIS'), encoding: 'shift_jis' }, { label: t('UTF-8'), encoding: 'utf8' },
      ], { title: t('Choose CSV encoding'), placeHolder: t('The file could not be read as UTF-8. Choose its encoding.') });
      if (!choice) throw error;
      format = { ...format, encoding: choice.encoding };
      document = await CsvDocument.open(uri, worker, undefined, hasHeader, format);
      await this.context.workspaceState.update(`format:${uri.toString()}`, format);
    }
    document.onEdit = event => this.changes.fire(event);
    return document;
  }

  async resolveCustomEditor(document: CsvDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    this.prompts.get(document)?.dispose();
    const prompts = new WebviewPrompts(webview);
    this.prompts.set(document, prompts);
    const filePicker = new WorkspaceFilePicker(prompts);
    const backupPolicy = new BackupPolicy(this.history, prompts);
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const post = (message: HostMessage): void => { void webview.postMessage(message); };
    this.webviews.add(webview);
    document.notify = post;
    let savePrompt: ((choice: SaveDecision | null) => void) | undefined;
    document.chooseSave = (saveAs, allowDiscard = false) => new Promise(resolve => {
      if (savePrompt) { resolve(null); return; }
      savePrompt = resolve; post({ type: 'savePrompt', saveAs, allowDiscard });
    });
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'grid.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'style.css'));
    const nonce = randomBytes(18).toString('hex');
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"><link rel="stylesheet" href="${style}"><title>Neat CSV</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const receive = webview.onDidReceiveMessage(async (message: ClientMessage) => {
      if (!message || !Number.isSafeInteger(message.id)) return;
      try {
        let result: unknown = null;
        switch (message.type) {
          case 'ready':
            post({ type: 'language', language: locale.language });
            if (document.metadata) post({ type: 'metadata', data: document.metadata });
            if (document.textDraft) post({ type: 'textRestore', start: document.textDraft.start });
            if (document.lastError) post({ type: 'error', message: document.lastError });
            document.notifyChanged();
            post({ type: 'guide', seen: this.context.globalState.get<boolean>('guideSeen', false) });
            break;
          case 'language':
            if (message.language !== 'en' && message.language !== 'zh-CN') throw new Error(t('Unsupported language.'));
            await this.context.globalState.update('language', message.language);
            locale.setLanguage(message.language);
            for (const current of this.webviews) void current.postMessage({ type: 'language', language: locale.language } satisfies HostMessage);
            break;
          case 'backupSettings': await backupPolicy.settings(); break;
          case 'promptChoice': prompts.answer(message.promptId, message.value); break;
          case 'guideSeen': await this.context.globalState.update('guideSeen', true); break;
          case 'clipboardRead': {
            const text = await vscode.env.clipboard.readText();
            if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Clipboard content exceeds 8 MB. Paste a smaller range.');
            result = text;
            break;
          }
          case 'clipboardWrite':
            if (typeof message.text !== 'string' || Buffer.byteLength(message.text) > 8 * 1024 * 1024) throw new Error('Clipboard content exceeds 8 MB. Copy a smaller range.');
            await vscode.env.clipboard.writeText(message.text);
            break;
          case 'pinRows': result = await document.run(() => document.engine.request({ method: 'pinRows', rows: message.rows })); break;
          case 'change': result = await document.change(message.operation); break;
          case 'configure':
            result = await document.configure(message.format);
            await this.context.workspaceState.update(`format:${document.uri.toString()}`, document.format);
            break;
          case 'search': result = await document.run(() => document.engine.request({ method: 'search', options: message.options })); break;
          case 'check': result = await document.run(() => document.engine.request({ method: 'check', options: message.options })); break;
          case 'distinct': result = await document.run(() => document.engine.request({ method: 'distinct', col: message.col })); break;
          case 'locate': result = await document.run(() => document.engine.request({ method: 'locate', row: message.row })); break;
          case 'textPage': result = await document.textPage(message.start, message.count); break;
          case 'textEdit': result = await document.textEdit(message.edit); break;
          case 'page':
            result = await document.run(() => document.engine.request({ method: 'page', start: message.start, count: message.count }));
            break;
          case 'query':
            result = await document.run(async () => {
              const data = await document.engine.request({ method: 'query', query: message.query });
              document.query = message.query;
              return data;
            });
            break;
          case 'confirmQuery': result = await confirmQuery(document.metadata, message.query, prompts); break;
          case 'header':
            result = await document.header(message.enabled);
            await this.context.workspaceState.update(`header:${document.uri.toString()}`, message.enabled);
            break;
          case 'copy':
            result = await document.run(() => document.engine.request({ method: 'copy', start: message.start, count: message.count, columns: message.columns, ranges: message.ranges, cells: message.cells, includeHeaders: message.includeHeaders }));
            break;
          case 'stats':
            result = await document.run(() => document.engine.request({ method: 'stats', start: message.start, count: message.count, columns: message.columns, ranges: message.ranges, cells: message.cells }));
            break;
          case 'openLink': {
            const url = new URL(message.url);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(t('Only HTTP and HTTPS links can be opened.'));
            result = await vscode.env.openExternal(vscode.Uri.parse(url.href));
            break;
          }
          case 'edit': await document.edit(message.edit); break;
          case 'saveChoice': savePrompt?.(message.choice); savePrompt = undefined; break;
          case 'save': {
            const options = { edits: true, sort: false, filters: false };
            if (document.changes) {
              document.nextSave = { saveAs: false, options };
              try { await vscode.commands.executeCommand('workbench.action.files.save'); }
              finally { document.nextSave = undefined; }
            }
            await this.context.workspaceState.update(`format:${document.uri.toString()}`, document.format);
            break;
          }
          case 'saveAs':
          case 'export': {
            let target = await filePicker.pick(document.uri, message.type === 'export' ? 'export' : 'saveAs');
            if (!target) break;
            const encoding = await filePicker.outputEncoding(message.type === 'export' ? message.encoding ?? document.format.encoding : document.format.encoding);
            if (!encoding) break;
            const options = message.type === 'export'
              ? { edits: true, sort: true, filters: true, columns: message.columns, encoding }
              : { edits: true, sort: false, filters: false, encoding };
            target = await this.saveTo(document, target, options);
            await this.context.workspaceState.update(`header:${target.toString()}`, document.metadata?.hasHeader ?? true);
            await this.context.workspaceState.update(`format:${target.toString()}`, { ...document.format, encoding: 'encoding' in options ? options.encoding ?? document.format.encoding : document.format.encoding });
            break;
          }
          case 'versions': {
            const versions = message.scope === 'all' ? await this.history.listAll() : await this.history.list(document.uri.fsPath);
            result = { versions, bytes: versions.reduce((sum, entry) => sum + entry.bytes, 0), totalBytes: await this.history.usage() };
            break;
          }
          case 'clearVersions': {
            const clear = t('Delete saved versions');
            const confirmed = await prompts.prompt({ kind: 'choice', layout: 'actions', title: t(message.scope === 'all' ? 'Delete saved versions for all files?' : 'Delete saved versions for this file?'), detail: t('Current CSV files and unsaved edits will stay unchanged. Deleted versions cannot be recovered.'), choices: [{ id: 'delete', label: clear }] }) === 'delete';
            if (confirmed) await this.history.clear(message.scope === 'all' ? undefined : document.uri.fsPath);
            result = { cleared: confirmed };
            break;
          }
          case 'recover': {
            const source = message.source ?? document.uri.fsPath;
            const snapshot = await this.history.get(source, message.version);
            if (message.saveAs || source !== document.uri.fsPath) {
              const target = await filePicker.pick(document.uri, 'recover');
              if (target) {
                if (target.toString() === document.uri.toString()) throw new Error(t('Choose a different file, or select Overwrite in Recover.'));
                const temp = join(dirname(target.fsPath), `.${basename(target.fsPath)}.${randomBytes(12).toString('hex')}.tmp`);
                try {
                  await copyFile(snapshot.path, temp);
                  await (await backupPolicy.forTarget(target))?.capture(target.fsPath, snapshot.version.hasHeader, snapshot.version.format);
                  await rename(temp, target.fsPath);
                  await this.context.workspaceState.update(`header:${target.toString()}`, snapshot.version.hasHeader);
                  if (snapshot.version.format) await this.context.workspaceState.update(`format:${target.toString()}`, snapshot.version.format);
                } finally { await unlink(temp).catch(() => {}); }
              }
            } else {
              await document.recover(snapshot.path, snapshot.version.hasHeader, await backupPolicy.forTarget(document.uri), snapshot.version.format);
              await this.context.workspaceState.update(`header:${document.uri.toString()}`, snapshot.version.hasHeader);
              await this.context.workspaceState.update(`format:${document.uri.toString()}`, document.format);
            }
            break;
          }
          case 'undo': await vscode.commands.executeCommand('undo'); break;
          case 'redo': await vscode.commands.executeCommand('redo'); break;
          default: throw new Error(t('Unknown Neat CSV request.'));
        }
        post({ type: 'response', id: message.id, result });
      } catch (error) {
        if (error instanceof vscode.CancellationError) { post({ type: 'response', id: message.id, result: null }); return; }
        post({ type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) });
      }
    });
    panel.onDidDispose(() => { prompts.dispose(); if (this.prompts.get(document) === prompts) this.prompts.delete(document); this.webviews.delete(webview); savePrompt?.(null); receive.dispose(); document.notify = () => {}; document.chooseSave = async () => null; });
  }

  private async saveTo(document: CsvDocument, target: vscode.Uri, options: SaveOptions): Promise<vscode.Uri> {
    const ui = this.editorUi(document);
    target = await new SaveTarget(ui).choose(document.uri, target);
    await document.save(target, options, await new BackupPolicy(this.history, ui).forTarget(target));
    return target;
  }

  async saveCustomDocument(document: CsvDocument): Promise<void> {
    const ui = this.editorUi(document);
    const filePicker = new WorkspaceFilePicker(ui);
    const choice = document.nextSave ?? await document.chooseSave(false, true);
    if (!choice) throw new vscode.CancellationError();
    if ('discard' in choice) { await document.revert(); return; }
    if (choice.saveAs) {
      let target = await filePicker.pick(document.uri, 'saveAs');
      if (target && target.toString() !== document.uri.toString()) {
        target = await this.saveTo(document, target, choice.options);
        await this.context.workspaceState.update(`header:${target.toString()}`, document.metadata?.hasHeader ?? true);
        await this.context.workspaceState.update(`format:${target.toString()}`, { ...document.format, encoding: choice.options.encoding ?? document.format.encoding });
      }
      // Exporting a copy keeps the original document dirty.
      throw new vscode.CancellationError();
    }
    const actualTarget = await this.saveTo(document, document.uri, choice.options);
    if (actualTarget.toString() !== document.uri.toString()) throw new vscode.CancellationError();
    await this.context.workspaceState.update(`format:${document.uri.toString()}`, document.format);
  }
  async saveCustomDocumentAs(document: CsvDocument, destination: vscode.Uri): Promise<void> {
    const ui = this.editorUi(document);
    const filePicker = new WorkspaceFilePicker(ui);
    const encoding = await filePicker.outputEncoding(document.format.encoding);
    if (!encoding) throw new vscode.CancellationError();
    const options = { edits: true, sort: false, filters: false, encoding };
    const requestedDestination = destination;
    destination = await this.saveTo(document, destination, options);
    await this.context.workspaceState.update(`header:${destination.toString()}`, document.metadata?.hasHeader ?? true);
    await this.context.workspaceState.update(`format:${destination.toString()}`, { ...document.format, encoding });
    if (destination.toString() !== requestedDestination.toString()) throw new vscode.CancellationError();
  }
  revertCustomDocument(document: CsvDocument): Promise<void> { return document.revert(); }
  async backupCustomDocument(document: CsvDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(context.destination, '..'));
    const id = await document.backup(context.destination);
    return {
      id,
      delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch {} },
    };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CsvEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('vscode-csv.editor', provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }),
    vscode.commands.registerCommand('vscode-csv.open', async (uri?: vscode.Uri) => {
      if (!uri) uri = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CSV / TSV': ['csv', 'tsv'] } }))?.[0];
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode-csv.editor');
    }),
  );
}
