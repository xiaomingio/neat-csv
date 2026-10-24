/*
Position the guided tour over real controls and clean up temporary previews.
*/
import { t, locale } from '../Locale';

export type GuideStep = {
  title: string;
  text: string;
  target: () => HTMLElement | null;
  preview?: () => HTMLElement;
  enter?: () => void | Promise<void>;
  leave?: () => void;
};

export class QuickGuide {
  private readonly dialog = document.createElement('dialog');
  private readonly spotlight = document.createElement('div');
  private readonly panel = document.createElement('section');
  private readonly arrow = document.createElement('span');
  private readonly title = document.createElement('header');
  private readonly body = document.createElement('div');
  private readonly progress = document.createElement('span');
  private readonly back = document.createElement('button');
  private readonly next = document.createElement('button');
  private readonly reminder = document.createElement('dialog');
  private skipped = false;
  private steps: GuideStep[] = [];
  private index = 0;
  private frame?: number;
  private returnFocus?: HTMLElement;
  private scrollers: { element: HTMLElement; left: number; top: number }[] = [];

  constructor(private readonly root: HTMLElement, private readonly seen: () => void, private readonly createSteps: () => GuideStep[], private readonly restore: () => void) {
    this.dialog.className = 'quick-guide';
    this.panel.className = 'cell-dialog guide-panel';
    this.spotlight.className = 'guide-spotlight'; this.spotlight.setAttribute('aria-hidden', 'true');
    this.arrow.className = 'guide-arrow'; this.arrow.setAttribute('aria-hidden', 'true');
    this.title.id = 'quick-guide-title'; this.dialog.setAttribute('aria-labelledby', this.title.id);
    this.body.className = 'guide-body'; this.body.id = 'quick-guide-description';
    this.dialog.setAttribute('aria-describedby', this.body.id);
    this.progress.className = 'guide-progress'; this.progress.setAttribute('aria-live', 'polite');
    const reminderText = 'Reopen this guide anytime with the ? button at the top right or View → Quick guide.';
    this.reminder.className = 'cell-dialog prompt-dialog guide-reminder'; this.reminder.setAttribute('aria-label', t('Quick guide'));
    const reminderTitle = document.createElement('header'); reminderTitle.textContent = t('Quick guide');
    const message = document.createElement('p'); message.className = 'guide-reminder-message'; message.textContent = t(reminderText);
    const dismiss = document.createElement('button'); dismiss.textContent = t('Got it');
    dismiss.onclick = () => this.reminder.close();
    const reminderFooter = document.createElement('footer'); reminderFooter.append(dismiss);
    this.reminder.append(reminderTitle, message, reminderFooter); root.append(this.reminder);
    const skip = document.createElement('button'); skip.textContent = t('Skip'); skip.onclick = () => {
      this.skipped = true; this.dialog.close();
    };
    this.back.textContent = t('Back'); this.back.onclick = () => void this.go(this.index - 1);
    locale.subscribe(() => { this.reminder.setAttribute('aria-label', t('Quick guide')); reminderTitle.textContent = t('Quick guide'); message.textContent = t(reminderText); dismiss.textContent = t('Got it'); skip.textContent = t('Skip'); this.back.textContent = t('Back'); this.next.textContent = t(this.index === this.steps.length - 1 ? 'Done' : 'Next'); });
    this.next.onclick = () => { if (this.index === this.steps.length - 1) this.dialog.close(); else void this.go(this.index + 1); };
    const footer = document.createElement('footer'); footer.append(this.progress, skip, this.back, this.next);
    this.panel.append(this.title, this.body, footer, this.arrow);
    this.dialog.append(this.spotlight, this.panel); root.append(this.dialog);
    this.dialog.addEventListener('pointerdown', event => {
      event.stopPropagation();
      if (!this.panel.contains(event.target as Node)) event.preventDefault();
    });
    this.dialog.addEventListener('focusin', event => event.stopPropagation());
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('close', () => {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.frame = undefined; this.steps[this.index]?.leave?.();
      this.restore();
      for (const item of this.scrollers) { item.element.scrollLeft = item.left; item.element.scrollTop = item.top; }
      if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
      if (this.skipped) { this.skipped = false; this.reminder.showModal(); }
    });
  }

  get open(): boolean { return this.dialog.open; }

  show(): void {
    if (this.open) return;
    if (this.reminder.open) this.reminder.close();
    this.steps = this.createSteps(); if (!this.steps.length) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.scrollers = Array.from(this.root.querySelectorAll<HTMLElement>('.toolbar, .viewport, .cm-scroller')).map(element => ({ element, left: element.scrollLeft, top: element.scrollTop }));
    this.index = -1; this.dialog.showModal(); void this.go(0); this.seen();
    const follow = () => { if (!this.open) return; this.position(); this.frame = requestAnimationFrame(follow); };
    this.frame = requestAnimationFrame(follow);
  }

  private async go(index: number): Promise<void> {
    this.steps[this.index]?.leave?.(); this.index = index;
    const step = this.steps[index];
    this.title.textContent = t(step.title); this.body.textContent = t(step.text);
    if (step.preview) this.body.append(step.preview());
    this.progress.textContent = `${index + 1} / ${this.steps.length}`;
    this.back.disabled = true; this.next.disabled = true;
    this.next.textContent = t(index === this.steps.length - 1 ? 'Done' : 'Next');
    this.panel.setAttribute('aria-busy', 'true');
    await step.enter?.();
    if (!this.open || this.index !== index) return;
    this.panel.removeAttribute('aria-busy');
    this.back.disabled = index === 0; this.next.disabled = false;
    step.target()?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    this.position();
    this.next.focus({ preventScroll: true });
  }

  private position(): void {
    const element = this.steps[this.index]?.target();
    const rect = element?.getBoundingClientRect();
    const width = window.innerWidth, height = window.innerHeight, margin = 10, gap = 16;
    const target = rect && rect.width && rect.height ? {
      left: Math.max(0, rect.left - 4), top: Math.max(0, rect.top - 4),
      right: Math.min(width, rect.right + 4), bottom: Math.min(height, rect.bottom + 4),
    } : { left: width / 2 - 16, right: width / 2 + 16, top: 40, bottom: 72 };
    this.spotlight.style.cssText = `left:${target.left}px;top:${target.top}px;width:${Math.max(0, target.right - target.left)}px;height:${Math.max(0, target.bottom - target.top)}px`;
    const panel = this.panel.getBoundingClientRect(), centerX = (target.left + target.right) / 2, centerY = (target.top + target.bottom) / 2;
    const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));
    let side: 'top' | 'bottom' | 'left' | 'right', left: number, top: number;
    if (height - target.bottom >= panel.height + gap + margin) {
      side = 'bottom'; left = clamp(centerX - panel.width / 2, width - panel.width); top = target.bottom + gap;
    } else if (target.top >= panel.height + gap + margin) {
      side = 'top'; left = clamp(centerX - panel.width / 2, width - panel.width); top = target.top - gap - panel.height;
    } else if (width - target.right >= panel.width + gap + margin) {
      side = 'right'; left = target.right + gap; top = clamp(centerY - panel.height / 2, height - panel.height);
    } else {
      side = 'left'; left = clamp(target.left - gap - panel.width, width - panel.width); top = clamp(centerY - panel.height / 2, height - panel.height);
    }
    this.panel.style.left = `${left}px`; this.panel.style.top = `${top}px`; this.panel.dataset.side = side;
    this.panel.style.setProperty('--guide-arrow-x', `${Math.max(18, Math.min(panel.width - 18, centerX - left))}px`);
    this.panel.style.setProperty('--guide-arrow-y', `${Math.max(18, Math.min(panel.height - 18, centerY - top))}px`);
  }
}
