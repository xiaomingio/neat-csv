/*
Provide a language submenu and backup settings with keyboard and pointer navigation.
*/
import { locale, t, type Language } from '../Locale';
import { ToolbarMenu } from './ToolbarMenu';

export class LanguageMenu {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  constructor(root: HTMLElement, onChange: (language: Language) => void, openBackupSettings: () => void) {
    const language = document.createElement('button'); language.type = 'button'; language.className = 'menu-top-action';
    language.setAttribute('aria-haspopup', 'menu'); language.setAttribute('aria-expanded', 'false');
    const backup = document.createElement('button'); backup.type = 'button'; backup.className = 'menu-top-action'; backup.onclick = openBackupSettings;
    const submenu = document.createElement('div'); submenu.className = 'command-menu language-submenu'; submenu.hidden = true;
    submenu.setAttribute('role', 'menu');
    const choices = (['en', 'zh-CN'] as const).map(value => {
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitemradio');
      item.textContent = value === 'en' ? 'English' : '简体中文';
      item.setAttribute('aria-label', item.textContent);
      item.onclick = () => { locale.setLanguage(value); onChange(value); close(); menu.close(); };
      const update = () => { item.setAttribute('aria-checked', String(locale.language === value)); item.setAttribute('aria-pressed', String(locale.language === value)); };
      update(); locale.subscribe(update); return item;
    });
    submenu.append(...choices);
    const menu = new ToolbarMenu(root, 'Settings', [language, backup]); this.button = menu.button; this.panel = menu.panel;
    this.panel.append(submenu);
    const close = () => { submenu.hidden = true; language.setAttribute('aria-expanded', 'false'); };
    const open = (focus = false) => {
      submenu.hidden = false; language.setAttribute('aria-expanded', 'true');
      const rect = language.getBoundingClientRect(), parent = this.panel.getBoundingClientRect();
      const width = submenu.offsetWidth, height = submenu.offsetHeight;
      const rightFits = parent.right + width <= innerWidth - 4;
      const leftFits = parent.left - width >= 4;
      const left = rightFits ? parent.right : leftFits ? parent.left - width : Math.max(4, Math.min(parent.left, innerWidth - width - 4));
      const inset = choices[0].getBoundingClientRect().top - submenu.getBoundingClientRect().top;
      const top = rightFits || leftFits ? rect.top - inset : parent.bottom + height <= innerHeight - 4 ? parent.bottom : parent.top - height;
      submenu.style.left = `${left}px`;
      submenu.style.top = `${Math.max(4, Math.min(top, innerHeight - height - 4))}px`;
      if (focus) (choices.find(item => item.getAttribute('aria-checked') === 'true') ?? choices[0]).focus();
    };
    language.onclick = event => { event.stopPropagation(); open(true); };
    language.onmouseenter = () => open();
    language.onkeydown = event => {
      if (event.key !== 'ArrowRight' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation(); open(true);
    };
    submenu.onkeydown = event => {
      if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); language.focus(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
      }
    };
    new MutationObserver(() => { if (this.panel.hidden) close(); }).observe(this.panel, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('resize', close);
    const update = () => {
      language.replaceChildren(document.createTextNode(t('Language')));
      const arrow = document.createElement('span'); arrow.className = 'submenu-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true'); language.append(arrow);
      language.setAttribute('aria-label', t('Language')); submenu.setAttribute('aria-label', t('Language'));
      backup.textContent = t('Backup settings…'); backup.dataset.tooltip = t('Click: change automatic backups, storage limit, and large-file warnings');
    };
    update(); locale.subscribe(update);
  }
}
