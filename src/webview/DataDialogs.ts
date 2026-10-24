/*
Provide compact dialogs for data commands with visible errors and asynchronous actions.
*/
import { t } from '../Locale';

export class DataDialogs {
  readonly dialog = document.createElement('dialog');
  constructor(root: HTMLElement) { this.dialog.className = 'cell-dialog data-dialog'; root.append(this.dialog); }
  get open(): boolean { return this.dialog.open; }

  input(label: string, value = '', type = 'text'): HTMLInputElement {
    const input = document.createElement('input'); input.type = type; input.value = value; input.setAttribute('aria-label', t(label)); return input;
  }
  field(label: string, control: HTMLElement): HTMLLabelElement {
    const field = document.createElement('label'); const text = document.createElement('span'); text.textContent = t(label); field.append(text, control); return field;
  }
  select(label: string, values: [string, string][], value?: string): HTMLSelectElement {
    const select = document.createElement('select'); select.setAttribute('aria-label', t(label));
    for (const [key, text] of values) { const option = document.createElement('option'); option.value = key; option.textContent = text; select.append(option); }
    if (value !== undefined) select.value = value; return select;
  }
  check(label: string, checked = false): HTMLLabelElement {
    const control = this.input(label, '', 'checkbox'); control.checked = checked; const field = this.field(label, control); field.className = 'data-checkbox'; return field;
  }
  body(...children: HTMLElement[]): HTMLElement { const body = document.createElement('div'); body.className = 'data-dialog-body'; body.append(...children); return body; }

  show(title: string, body: HTMLElement, actions: { label: string; run: () => void | Promise<void>; close?: boolean }[]): void {
    if (this.open) this.dialog.close();
    const heading = document.createElement('header'); heading.textContent = t(title); heading.id = 'data-dialog-title';
    this.dialog.setAttribute('aria-labelledby', heading.id);
    const error = document.createElement('div'); error.className = 'dialog-error'; error.setAttribute('role', 'alert');
    const footer = document.createElement('footer'); const close = document.createElement('button'); close.textContent = t('Close'); close.onclick = () => this.dialog.close(); footer.append(close);
    for (const action of actions) {
      const button = document.createElement('button'); button.textContent = t(action.label);
      button.onclick = async () => {
        const buttons = Array.from(footer.querySelectorAll('button')); buttons.forEach(item => item.disabled = true); error.textContent = '';
        try { await action.run(); if (action.close) this.dialog.close(); }
        catch (reason) { error.textContent = t(reason instanceof Error ? reason.message : String(reason)); }
        finally { buttons.forEach(item => item.disabled = false); }
      }; footer.append(button);
    }
    this.dialog.replaceChildren(heading, body, error, footer); this.dialog.showModal();
    body.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }
}
