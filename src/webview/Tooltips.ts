/*
Show toolbar operation hints and keep native button titles synchronized with dynamic controls.
*/
import { locale, t } from '../Locale';

export class Tooltips {
  private readonly hint: HTMLElement;
  private target?: HTMLElement;
  private hovered?: HTMLElement;
  private previewContent?: string;

  constructor(private readonly root: HTMLElement) {
    this.hint = root.querySelector<HTMLElement>('.toolbar-hint')!;
    this.syncTitles(root);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') this.syncTitles(record.target);
        else {
          if (record.target instanceof HTMLButtonElement) this.syncTitles(record.target);
          for (const node of record.addedNodes) this.syncTitles(node);
        }
      }
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tooltip', 'aria-label'] });
    root.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch' || event.buttons) return;
      this.hovered = this.control(event.target); this.show(this.hovered);
    });
    root.addEventListener('pointerout', event => { this.hovered = this.control(event.relatedTarget); this.show(this.hovered); });
    root.addEventListener('focusin', event => this.show(this.control(event.target) ?? this.hovered));
    root.addEventListener('focusout', event => this.show(this.control(event.relatedTarget) ?? this.hovered));
    document.addEventListener('pointerdown', event => { this.hovered = this.control(event.target); this.show(this.hovered); }, true);
    document.addEventListener('dragstart', () => this.show(undefined), true);
    document.addEventListener('scroll', () => this.show(undefined), true);
    window.addEventListener('blur', () => this.show(undefined));
    locale.subscribe(() => { this.syncTitles(root); this.show(this.target); });
  }

  private syncTitles(node: Node): void {
    const update = (button: HTMLButtonElement) => {
      button.title = t(button.dataset.tooltip ?? button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '').replace(/\s*·\s*/g, ' | ');
    };
    if (node instanceof HTMLButtonElement) update(node);
    if (node instanceof Element) node.querySelectorAll<HTMLButtonElement>('button').forEach(update);
  }

  private control(node: EventTarget | null): HTMLElement | undefined {
    const target = node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null;
    return target && this.root.contains(target) ? target : undefined;
  }

  preview(target?: HTMLElement): void {
    this.previewContent = target?.dataset.tooltip; this.show(this.target);
  }

  private show(target: HTMLElement | undefined): void {
    this.target = target?.isConnected ? target : undefined;
    const content = this.previewContent ?? this.target?.dataset.tooltip;
    this.hint.textContent = content ? `Tips: ${t(content).replace(/\s*·\s*/g, ' | ')}` : '';
  }
}
