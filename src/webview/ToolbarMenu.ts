/*
Manage app menus, placement, sibling switching, and keyboard navigation.
*/
import { t, locale } from '../Locale';

export class ToolbarMenu {
  private static readonly groups = new WeakMap<HTMLElement, ToolbarMenu[]>();
  private readonly peers: ToolbarMenu[];
  readonly button = document.createElement('button');
  readonly panel = document.createElement('div');

  constructor(root: HTMLElement, label: string, items: HTMLButtonElement[]) {
    this.peers = ToolbarMenu.groups.get(root) ?? []; this.peers.push(this); ToolbarMenu.groups.set(root, this.peers);
    this.button.type = 'button'; this.button.className = 'toolbar-menu-button';
    const tooltip = ({ File: 'Click: save or recover a version', View: 'Click: manage headers, columns, or table layout', Edit: 'Click: find, replace, copy, or paste', Data: 'Click: check data or choose the file format', Settings: 'Click: change language or backup settings' }[label] ?? 'Click: open {menu} commands');
    const updateLanguage = () => {
      this.button.textContent = t(label); this.button.dataset.tooltip = t(tooltip, { menu: t(label) });
      this.button.setAttribute('aria-label', t(label)); this.panel.setAttribute('aria-label', t('{menu} commands', { menu: t(label) }));
    };
    updateLanguage(); locale.subscribe(updateLanguage);
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-expanded', 'false');
    this.panel.className = 'command-menu'; this.panel.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    for (const button of items) if (button.dataset.shortcut) {
      const label = document.createElement('span'); label.className = 'menu-label'; label.textContent = button.textContent;
      const shortcut = document.createElement('span'); shortcut.className = 'menu-shortcut'; shortcut.textContent = button.dataset.shortcut; shortcut.setAttribute('aria-hidden', 'true');
      button.replaceChildren(label, shortcut); button.classList.add('menu-with-shortcut');
    }
    this.panel.append(...items); root.append(this.panel);
    this.button.onclick = () => { if (this.panel.hidden) this.show(true); else this.close(); };
    this.button.addEventListener('mouseenter', () => {
      if (!this.button.disabled && this.peers.some(menu => menu !== this && !menu.panel.hidden)) this.show(true);
    });
    this.button.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.adjacent(event.key === 'ArrowRight' ? 1 : -1, !this.panel.hidden); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); this.show(true); }
    });
    this.panel.addEventListener('click', event => {
      if ((event.target as Element).closest('button')) this.close();
    });
    this.panel.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.adjacent(event.key === 'ArrowRight' ? 1 : -1, true); return; }
      if (event.key === 'Escape') { event.preventDefault(); this.close(); this.button.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const enabled = Array.from(this.panel.querySelectorAll<HTMLButtonElement>('button:enabled')).filter(button => button.getClientRects().length);
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); enabled[(index + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]?.focus();
    });
    document.addEventListener('pointerdown', event => {
      if (!this.button.contains(event.target as Node) && !this.panel.contains(event.target as Node)) this.close();
    });
    document.addEventListener('focusin', event => {
      if (!this.button.contains(event.target as Node) && !this.panel.contains(event.target as Node)) this.close();
    });
    window.addEventListener('resize', () => this.position());
    document.addEventListener('keydown', event => { if (event.key === 'Escape') this.close(); });
  }

  show(focus = false): void {
    this.peers.forEach(menu => { if (menu !== this) menu.close(); });
    this.panel.hidden = false; this.button.setAttribute('aria-expanded', 'true'); this.position();
    if (focus) this.panel.querySelector<HTMLButtonElement>('button:enabled')?.focus();
  }

  close(): void { this.panel.hidden = true; this.button.setAttribute('aria-expanded', 'false'); }

  private adjacent(direction: number, open: boolean): void {
    const enabled = this.peers.filter(menu => !menu.button.disabled);
    const next = enabled[(enabled.indexOf(this) + direction + enabled.length) % enabled.length];
    if (!next) return; this.close(); next.button.focus(); if (open) next.show(true);
  }

  private position(): void {
    if (this.panel.hidden) return;
    const rect = this.button.getBoundingClientRect();
    this.panel.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - this.panel.offsetWidth - 4))}px`;
    this.panel.style.top = `${Math.max(4, Math.min(rect.bottom, innerHeight - this.panel.offsetHeight - 4))}px`;
  }
}
