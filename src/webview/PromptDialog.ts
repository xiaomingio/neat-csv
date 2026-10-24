/*
Present host choices, inputs, and settings in one accessible webview modal.
*/
import { t } from '../Locale';
import type { HostPrompt, PromptValue } from '../protocol';

export class PromptDialog {
  private readonly dialog = document.createElement('dialog');
  private pending?: (value: PromptValue) => void;
  private previousFocus?: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    this.dialog.className = 'cell-dialog prompt-dialog'; root.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.finish(null); });
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.finish(null); });
    this.dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [...this.dialog.querySelectorAll<HTMLElement>('button:enabled, input:enabled')].filter(control => control.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    window.addEventListener('pagehide', () => this.finish(null));
  }

  get open(): boolean { return this.dialog.open; }

  show(prompt: HostPrompt): Promise<PromptValue> {
    this.finish(null);
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const heading = document.createElement('header'); heading.id = 'host-prompt-title'; heading.textContent = prompt.title;
    this.dialog.setAttribute('aria-labelledby', heading.id);
    const body = document.createElement('form'); body.className = 'prompt-body'; body.noValidate = true;
    for (const [text, className] of [[prompt.message, 'prompt-message'], [prompt.detail, 'prompt-detail']]) {
      if (!text) continue;
      const paragraph = document.createElement('p'); paragraph.className = className!; paragraph.textContent = text; body.append(paragraph);
    }
    const inputs = new Map<string, HTMLInputElement>();
    const field = (id: string, label: string, type: string, value: string | boolean, options: { min?: number; max?: number; required?: boolean; pattern?: string } = {}) => {
      const wrapper = document.createElement('label'); wrapper.className = type === 'checkbox' ? 'prompt-checkbox' : 'prompt-field';
      const name = document.createElement('span'); name.textContent = label;
      const input = document.createElement('input'); input.type = type; input.setAttribute('aria-label', label);
      if (type === 'checkbox') input.checked = Boolean(value); else input.value = String(value);
      if (options.min !== undefined) input.min = String(options.min);
      if (options.max !== undefined) input.max = String(options.max);
      input.required = Boolean(options.required); if (options.pattern) input.pattern = options.pattern;
      if (type === 'number') input.step = 'any';
      wrapper.append(name, input); body.append(wrapper); inputs.set(id, input); return input;
    };
    if (prompt.kind === 'input') {
      const input = field('value', prompt.title, prompt.input?.kind ?? 'text', prompt.value ?? '', { ...prompt.input, required: true });
      input.placeholder = prompt.placeholder ?? '';
    }
    if (prompt.kind === 'form') for (const item of prompt.fields ?? []) field(item.id, item.label, item.type, item.value, item);
    const error = document.createElement('p'); error.className = 'dialog-error'; error.id = 'host-prompt-error'; error.setAttribute('role', 'alert'); error.textContent = prompt.validationMessage ?? '';
    const choices = document.createElement('div'); choices.className = 'prompt-choices';
    for (const choice of prompt.choices ?? []) {
      const button = document.createElement('button'); button.type = 'button';
      const name = document.createElement('span'); name.textContent = choice.label; button.append(name);
      if (choice.description) { const description = document.createElement('small'); description.textContent = choice.description; button.append(description); }
      button.onclick = () => this.finish(choice.id); choices.append(button);
    }
    choices.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...choices.querySelectorAll('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
    const actionChoices = prompt.kind === 'choice' && prompt.layout === 'actions';
    if (choices.childElementCount && !actionChoices) body.append(choices);
    const footer = document.createElement('footer');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('Cancel'); cancel.onclick = () => this.finish(null); footer.append(cancel);
    if (actionChoices) footer.append(...choices.children);
    if (prompt.kind !== 'choice') {
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = prompt.confirmLabel ?? t('Continue');
      const submit = () => {
        const invalid = [...inputs.values()].find(input => !input.checkValidity());
        if (invalid) { error.textContent = t('Enter a valid value for {field}.', { field: invalid.getAttribute('aria-label') ?? '' }); invalid.setAttribute('aria-invalid', 'true'); invalid.setAttribute('aria-describedby', error.id); invalid.focus(); return; }
        this.finish(prompt.kind === 'input' ? inputs.get('value')!.value : Object.fromEntries([...inputs].map(([id, input]) => [id, input.type === 'checkbox' ? input.checked : input.value])));
      };
      confirm.className = 'primary';
      confirm.onclick = submit; body.onsubmit = event => { event.preventDefault(); submit(); }; footer.append(confirm);
      body.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') { event.preventDefault(); submit(); } });
    } else body.onsubmit = event => event.preventDefault();
    if (actionChoices) footer.lastElementChild?.classList.add('primary');
    this.dialog.replaceChildren(heading, body, error, footer);
    return new Promise(resolve => {
      this.pending = resolve;
      try { this.dialog.showModal(); }
      catch { this.finish(null); return; }
      const first = prompt.kind === 'choice' ? (actionChoices ? footer.querySelector('button:not(:first-child)') : choices.querySelector('button')) : inputs.values().next().value;
      if (first instanceof HTMLElement) first.focus(); else cancel.focus();
      if (first instanceof HTMLInputElement && first.type !== 'checkbox') first.select();
    });
  }

  private finish(value: PromptValue): void {
    if (!this.pending) return;
    const resolve = this.pending; this.pending = undefined;
    if (this.dialog.open) this.dialog.close();
    const focus = this.previousFocus; this.previousFocus = undefined;
    if (focus?.isConnected && focus.getClientRects().length) focus.focus({ preventScroll: true });
    else this.root.querySelector<HTMLElement>('.viewport')?.focus({ preventScroll: true });
    resolve(value);
  }
}
