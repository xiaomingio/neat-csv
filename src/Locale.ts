/*
File purpose: Share an explicit English-first language model between the extension and webview.
*/
import { coreMessages } from './CoreMessages';

export type Language = 'en' | 'zh-CN';
export type TranslationParams = Record<string, string | number>;
const messages: Record<string, string> = { ...coreMessages };

class Locale {
  private current: Language = 'en';
  private readonly listeners = new Set<() => void>();
  get language(): Language { return this.current; }
  setLanguage(language: Language): void {
    if (language !== 'en' && language !== 'zh-CN') return;
    if (language === this.current) return;
    this.current = language;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const locale = new Locale();
export function registerTranslations(translations: Record<string, string>): void {
  Object.assign(messages, translations);
}
export function t(english: string, params: TranslationParams = {}): string {
  const template = locale.language === 'zh-CN' ? messages[english] ?? english : english;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name: string) => Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}
