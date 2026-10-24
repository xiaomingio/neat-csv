/*
Purpose: Verify webview prompts cancel safely on unavailable editors and accept only current business choices.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebviewPrompts } from '../src/EditorUi';
import type { HostMessage, HostPrompt } from '../src/protocol';

function fixture() {
  const requests: HostPrompt[] = [];
  const prompts = new WebviewPrompts({ postMessage: async (message: HostMessage) => { if (message.type === 'prompt') requests.push(message.prompt); return true; } });
  return { requests, prompts };
}

test('Only the current webview prompt can resolve a choice and invalid selections cancel', async () => {
  const { requests, prompts } = fixture();
  const first = prompts.prompt({ kind: 'choice', title: 'Large query', choices: [{ id: 'continue', label: 'Continue' }] });
  let resolved = false; void first.then(() => { resolved = true; });
  prompts.answer(requests[0].id + 1, 'continue'); await Promise.resolve(); assert.equal(resolved, false);
  assert.equal(await prompts.prompt({ kind: 'input', title: 'Other action' }), null);
  prompts.answer(requests[0].id, 'continue'); assert.equal(await first, 'continue');
  const second = prompts.prompt({ kind: 'choice', title: 'Replace', choices: [{ id: 'replace', label: 'Replace' }] });
  prompts.answer(requests[0].id, 'replace'); await Promise.resolve();
  prompts.answer(requests[1].id, 'unlisted action'); assert.equal(await second, null);
});

test('Editor disposal and failed message delivery resolve pending prompts without native fallback', async () => {
  const { requests, prompts } = fixture();
  const pending = prompts.prompt({ kind: 'input', title: 'File name', value: 'copy.csv' });
  prompts.dispose(); assert.equal(await pending, null);
  prompts.answer(requests[0].id, 'late.csv'); assert.equal(await prompts.prompt({ kind: 'input', title: 'Closed editor' }), null);
  for (const postMessage of [async () => false, async () => { throw new Error('Unavailable'); }, () => { throw new Error('Disposed'); }]) {
    const unavailable = new WebviewPrompts({ postMessage });
    assert.equal(await unavailable.prompt({ kind: 'choice', title: 'Confirm' }), null);
  }
});

test('Input and form responses preserve typed values and reject malformed settings', async () => {
  const { requests, prompts } = fixture();
  const input = prompts.prompt({ kind: 'input', title: 'Path', value: '/data/copy.csv' });
  prompts.answer(requests.at(-1)!.id, '/data/renamed.csv'); assert.equal(await input, '/data/renamed.csv');
  const fields = [{ id: 'enabled', label: 'Backups', type: 'checkbox' as const, value: true }, { id: 'limit', label: 'Limit', type: 'number' as const, value: '500' }];
  const malformed = prompts.prompt({ kind: 'form', title: 'Settings', fields });
  prompts.answer(requests.at(-1)!.id, { enabled: 'yes', limit: '500' }); assert.equal(await malformed, null);
  const form = prompts.prompt({ kind: 'form', title: 'Settings', fields });
  prompts.answer(requests.at(-1)!.id, { enabled: false, limit: '600' }); assert.deepEqual(await form, { enabled: false, limit: '600' });
  const canceled = prompts.prompt({ kind: 'form', title: 'Settings', fields });
  prompts.answer(requests.at(-1)!.id, null); assert.equal(await canceled, null);
});
