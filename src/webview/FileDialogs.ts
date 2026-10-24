/*
Collect save options and version recovery choices in compact confirmation dialogs.
*/
import { t, locale } from '../Locale';
import type { SaveDecision, VersionList } from '../protocol';

export class FileDialogs {
  private readonly dialog = document.createElement('dialog');
  constructor(root: HTMLElement) {
    this.dialog.className = 'cell-dialog file-dialog';
    root.append(this.dialog);
  }

  get open(): boolean { return this.dialog.open; }

  private destination(body: HTMLElement, fixedSaveAs: boolean): HTMLSelectElement {
    const label = document.createElement('label'); label.textContent = t('Destination');
    const select = document.createElement('select'); select.setAttribute('aria-label', t('Destination'));
    for (const [value, text] of [['overwrite', 'Overwrite current file'], ['saveAs', 'Save as…']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = t(text); select.append(option);
    }
    if (fixedSaveAs) { select.value = 'saveAs'; select.disabled = true; }
    label.append(select); body.append(label); return select;
  }

  private show<T>(title: string, body: HTMLElement, action: string, value: () => T, options: { alternative?: { label: string; value: () => T }; disabled?: boolean } = {}): Promise<T | null> {
    if (this.dialog.open) return Promise.resolve(null);
    const heading = document.createElement('header'); heading.textContent = t(title); heading.id = 'file-dialog-title';
    this.dialog.setAttribute('aria-labelledby', heading.id);
    const footer = document.createElement('footer');
    const cancel = document.createElement('button'); cancel.textContent = t('Cancel'); cancel.onclick = () => this.dialog.close();
    const confirm = document.createElement('button'); confirm.textContent = t(action);
    let result: T | null = null;
    confirm.disabled = Boolean(options.disabled);
    confirm.onclick = () => { result = value(); this.dialog.close(); };
    footer.append(cancel);
    if (options.alternative) {
      const alternative = document.createElement('button'); alternative.textContent = t(options.alternative.label);
      alternative.onclick = () => { result = options.alternative!.value(); this.dialog.close(); }; footer.append(alternative);
    }
    footer.append(confirm); this.dialog.replaceChildren(heading, body, footer);
    return new Promise(resolve => {
      this.dialog.addEventListener('close', () => resolve(result), { once: true });
      this.dialog.showModal(); cancel.focus();
    });
  }

  save(allowDiscard = false, canSave = true): Promise<SaveDecision | null> {
    const body = document.createElement('div'); body.className = 'file-dialog-body';
    const message = document.createElement('p');
    message.textContent = t(canSave ? 'Save your changes before closing?' : 'Fix the Text error before saving.');
    if (!canSave) message.className = 'overwrite-warning';
    body.append(message);
    return this.show<SaveDecision>('Save CSV', body, 'Save', () => ({ options: { edits: true, sort: false, filters: false }, saveAs: false }), {
      disabled: !canSave,
      alternative: allowDiscard ? { label: 'Don’t save', value: () => ({ discard: true }) } : undefined,
    });
  }

  recover(initial: VersionList, load: (scope: 'file' | 'all') => Promise<VersionList>, clear: (scope: 'file' | 'all') => Promise<void>): Promise<{ version: string; saveAs: boolean; source?: string } | null> {
    const body = document.createElement('div'); body.className = 'file-dialog-body';
    const scopeLabel = document.createElement('label'); scopeLabel.textContent = t('Backups');
    const scope = document.createElement('select'); scope.setAttribute('aria-label', t('Backup scope'));
    for (const [value, text] of [['file', 'Current file'], ['all', 'All files']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = t(text); scope.append(option);
    }
    scopeLabel.append(scope); body.append(scopeLabel);
    const label = document.createElement('label'); label.textContent = t('Version');
    const select = document.createElement('select'); select.setAttribute('aria-label', t('Version'));
    label.append(select); body.append(label);
    const details = document.createElement('p'); details.className = 'history-details'; body.append(details);
    const usage = document.createElement('p'); usage.className = 'history-usage'; body.append(usage);
    const destination = this.destination(body, false); destination.value = 'saveAs';
    const warning = document.createElement('p'); warning.className = 'overwrite-warning'; warning.textContent = t('This replaces the current file with the selected version. The current file is kept in Recover.'); body.append(warning);
    const cleanup = document.createElement('div'); cleanup.className = 'menu-actions';
    const clearFile = document.createElement('button'); clearFile.textContent = t('Clear current file backups');
    const clearAll = document.createElement('button'); clearAll.textContent = t('Clear all backups'); cleanup.append(clearFile, clearAll); body.append(cleanup);
    const error = document.createElement('p'); error.className = 'dialog-error'; error.setAttribute('role', 'alert'); body.append(error);
    let data = initial, busy = false;
    const selected = () => data.versions[Number(select.value)];
    const bytes = (value: number) => value < 1024 ? t('{count} bytes', { count: String(value) }) : `${(value / (1024 * 1024)).toLocaleString(locale.language, { maximumFractionDigits: 2 })} MiB`;
    const controls = () => {
      const confirm = this.dialog.querySelector<HTMLButtonElement>('footer button:last-child');
      if (confirm) confirm.disabled = busy || !selected();
      scope.disabled = select.disabled = clearFile.disabled = clearAll.disabled = busy;
      destination.disabled = busy || scope.value === 'all';
    };
    const detail = () => {
      const version = selected();
      details.textContent = version ? version.source && !version.source.startsWith('history:') ? version.source : t('Original path unavailable') : t('No saved versions yet. Versions are kept before a file is overwritten.');
      warning.hidden = destination.value !== 'overwrite'; controls();
    };
    const draw = () => {
      select.replaceChildren();
      data.versions.forEach((version, index) => {
        const option = document.createElement('option'); option.value = String(index);
        option.textContent = `${new Date(version.created).toLocaleString(locale.language)} · ${bytes(version.bytes)}`; select.append(option);
      });
      usage.textContent = t('Shown backups: {bytes} · Total storage: {total}', { bytes: bytes(data.bytes), total: bytes(data.totalBytes) });
      detail();
    };
    const refresh = async (action?: 'file' | 'all') => {
      if (busy) return; busy = true; error.textContent = ''; controls();
      try {
        if (action) await clear(action);
        data = await load(scope.value as 'file' | 'all'); draw();
      } catch (reason) { error.textContent = t(reason instanceof Error ? reason.message : String(reason)); }
      finally { busy = false; controls(); }
    };
    scope.onchange = () => { if (scope.value === 'all') destination.value = 'saveAs'; void refresh(); };
    select.onchange = detail; destination.onchange = detail;
    clearFile.onclick = () => void refresh('file'); clearAll.onclick = () => void refresh('all');
    draw();
    const result = this.show('Recover CSV', body, 'Recover', () => ({ version: selected()!.id, saveAs: destination.value === 'saveAs', ...(selected()!.source ? { source: selected()!.source } : {}) }), { disabled: !selected() });
    controls(); return result;
  }
}
