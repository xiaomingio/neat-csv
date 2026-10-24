/*
Purpose: Define editor-owned prompts and resolve webview choices without opening native confirmation windows.
*/
import type * as vscode from 'vscode';
import type { HostPrompt, PromptValue, HostMessage } from './protocol';

export type EditorPrompt = Omit<HostPrompt, 'id'>;
export type EditorUi = { prompt(options: EditorPrompt): Promise<PromptValue> };

export class WebviewPrompts implements EditorUi {
  private nextId = 0;
  private disposed = false;
  private pending?: { request: HostPrompt; resolve: (value: PromptValue) => void };
  constructor(private readonly webview: Pick<vscode.Webview, 'postMessage'>) {}

  prompt(options: EditorPrompt): Promise<PromptValue> {
    if (this.disposed || this.pending) return Promise.resolve(null);
    return new Promise(resolve => {
      const request = { ...options, id: ++this.nextId };
      this.pending = { request, resolve };
      try {
        void Promise.resolve(this.webview.postMessage({ type: 'prompt', prompt: request } satisfies HostMessage)).then(delivered => {
          if (!delivered) this.answer(request.id, null);
        }, () => this.answer(request.id, null));
      } catch { this.answer(request.id, null); }
    });
  }

  answer(id: number, value: PromptValue): void {
    if (!this.pending || this.pending.request.id !== id) return;
    const { request, resolve } = this.pending;
    this.pending = undefined;
    if (value === null) { resolve(null); return; }
    if (typeof value === 'string') {
      resolve(request.kind === 'input' || request.choices?.some(choice => choice.id === value) ? value : null);
      return;
    }
    if (request.kind !== 'form' || typeof value !== 'object' || Array.isArray(value)) { resolve(null); return; }
    const valid = request.fields?.every(field => typeof value[field.id] === (field.type === 'checkbox' ? 'boolean' : 'string'));
    resolve(valid ? value : null);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending) this.answer(this.pending.request.id, null);
  }
}
