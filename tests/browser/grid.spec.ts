/*
Purpose: Connect headless browser tests to the real engine to verify table interaction and original-coordinate saving.
*/
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionHistory } from '../../src/VersionHistory';
import { CsvFile } from '../../src/engine/CsvFile';
import { WebviewPrompts } from '../../src/EditorUi';
import { confirmQuery } from '../../src/QueryConfirmation';
import { SampleCsv } from '../../src/SampleCsv';
import { parse } from 'csv-parse/sync';
import type { CellEdit, ClientMessage, HostMessage, HostPrompt, PromptValue, Metadata } from '../../src/protocol';
import type { Language } from '../../src/Locale';

let directory: string, path: string, file: CsvFile, metadata: Metadata;
let changes: number;
let hostPrompts: WebviewPrompts;
let statsRequests: number;
let backupSettingsRequests: number;
let textRequests: number[];
let language: Language;
let clipboardText: string;
let clipboardFailure: string | undefined;
let holdDistinct = false;
let releaseDistinct: (() => void) | undefined;
const languageRequests: Language[] = [];
const links: string[] = [];
const promptAnswers: { id: number; value: PromptValue }[] = [];

async function toolbarCommand(page: Page, menu: 'File' | 'View' | 'Edit' | 'Data', name: string): Promise<void> {
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('dialog', { name: `${menu} commands`, exact: true }).getByRole('button', { name, exact: true }).click();
}

async function calculateSelection(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Calculate selection', exact: true });
  if (await button.isVisible()) await button.click();
}

test.beforeEach(async ({ page }) => {
  directory = await mkdtemp(join(tmpdir(), 'csv-grid-test-'));
  path = join(directory, 'input.csv');
  await writeFile(path, 'Product,Note,Link,Amount,Region,Active,Extra\n' + Array.from({ length: 600 }, (_, i) =>
    `Product ${String(600 - i).padStart(3, '0')},"line one\nline two",https://example.com/${i},${i},${i === 0 ? '10' : i === 1 ? '2' : i === 2 ? '' : i === 3 ? '   ' : 'Asia'},true,extra`
  ).join('\n') + '\n');
  let indexed!: () => void;
  const complete = new Promise<void>(resolve => { indexed = resolve; });
  file = new CsvFile(path, data => { metadata = data; if (data.complete) indexed(); });
  await file.open(); await complete;
  const history = new VersionHistory(join(directory, 'history'));
  let saveId = 0;
  promptAnswers.length = 0; changes = 0; backupSettingsRequests = 0; statsRequests = 0; textRequests = []; links.length = 0; language = 'en'; languageRequests.length = 0; clipboardText = ''; clipboardFailure = undefined; holdDistinct = false; releaseDistinct = undefined;
  const undoTokens: ({ before: string; after: string; structural: boolean } | { edit: CellEdit; value: string })[] = []; let undoPosition = 0;
  hostPrompts = new WebviewPrompts({ postMessage: async message => { await page.evaluate(message => window.postMessage(message, '*'), message); return true; } });
  await page.exposeFunction('sendToHost', async (message: ClientMessage): Promise<HostMessage[]> => {
    try {
      let result: unknown;
      if (message.type === 'ready') result = metadata;
      else if (message.type === 'language') { language = message.language; languageRequests.push(language); }
      else if (message.type === 'promptChoice') { promptAnswers.push({ id: message.promptId, value: message.value }); hostPrompts.answer(message.promptId, message.value); }
      else if (message.type === 'backupSettings') { backupSettingsRequests++; }
      else if (message.type === 'guideSeen') result = null;
      else if (message.type === 'clipboardRead') { if (clipboardFailure) throw new Error(clipboardFailure); result = clipboardText; }
      else if (message.type === 'clipboardWrite') { if (clipboardFailure) throw new Error(clipboardFailure); clipboardText = message.text; result = null; }
      else if (message.type === 'undo' || message.type === 'redo') {
        const index = message.type === 'undo' ? undoPosition - 1 : undoPosition;
        const token = undoTokens[index];
        if (token) {
          if ('edit' in token) await file.edit(message.type === 'undo' ? { ...token.edit, value: token.value } : token.edit);
          else await file.restore(message.type === 'undo' ? token.before : token.after);
          undoPosition += message.type === 'undo' ? -1 : 1; changes = file.changes;
        }
        return [{ type: 'metadata', data: metadata }, ...(token && !('edit' in token) && token.structural ? [{ type: 'viewReset' as const }] : []), { type: 'changed', changes, canUndo: undoPosition > 0, canRedo: undoPosition < undoTokens.length }, { type: 'response', id: message.id }];
      }
      else if (message.type === 'pinRows') result = await file.pinRows(message.rows);
      else if (message.type === 'page') result = await file.page(message.start, message.count);
      else if (message.type === 'confirmQuery') result = await confirmQuery(metadata, message.query, hostPrompts);
      else if (message.type === 'query') result = await file.query(message.query);
      else if (message.type === 'edit') {
        const before = await file.edit(message.edit); changes = file.changes;
        if (before.value !== message.edit.value) { undoTokens.splice(undoPosition); undoTokens.push({ edit: message.edit, value: before.value }); undoPosition++; }
      }
      else if (message.type === 'change') {
        const change = await file.change(message.operation); result = change; changes = file.changes;
        undoTokens.splice(undoPosition); undoTokens.push({ before: change.before, after: change.after, structural: ['insertRows', 'deleteRows', 'insertColumn', 'deleteColumns', 'moveRow', 'moveColumn'].includes(message.operation.kind) }); undoPosition++;
        return [{ type: 'metadata', data: metadata }, { type: 'changed', changes, canUndo: true, canRedo: false }, { type: 'response', id: message.id, result }];
      }
      else if (message.type === 'configure') {
        result = await file.configure(message.format);
        return [{ type: 'metadata', data: metadata }, { type: 'viewReset' }, { type: 'response', id: message.id, result: metadata }];
      }
      else if (message.type === 'search') result = await file.search(message.options);
      else if (message.type === 'check') result = await file.check(message.options);
      else if (message.type === 'distinct') {
        result = await file.distinct(message.col);
        if (holdDistinct) await new Promise<void>(resolve => { releaseDistinct = resolve; });
      }
      else if (message.type === 'locate') result = await file.locate(message.row);
      else if (message.type === 'textPage') { textRequests.push(message.start); result = await file.textPage(message.start, message.count); }
      else if (message.type === 'textEdit') { result = await file.textEdit(message.edit); changes = file.changes; }
      else if (message.type === 'save' || message.type === 'saveAs' || message.type === 'export') {
        const target = message.type === 'save' ? path : join(directory, message.type === 'export' ? 'export.csv' : 'copy.csv');
        if (message.type === 'save' && !changes) return [{ type: 'response', id: message.id }];
        await history.capture(target, metadata.hasHeader);
        await file.save(target, message.type === 'export' ? { edits: true, sort: true, filters: true, columns: message.columns, encoding: message.encoding } : { edits: true, sort: false, filters: false });
        if (message.type === 'save') { changes = 0; return [{ type: 'metadata', data: metadata }, { type: 'changed', changes }, { type: 'response', id: message.id }]; }
      }
      else if (message.type === 'saveChoice') {
        const replies: HostMessage[] = [];
        if (message.choice && 'discard' in message.choice) {
          await file.reload(); changes = 0;
          return [{ type: 'changed', changes }, { type: 'viewReset' }, { type: 'response', id: message.id }];
        }
        if (message.choice) {
          const target = message.choice.saveAs ? join(directory, 'export.csv') : path;
          await history.capture(target, metadata.hasHeader);
          await file.save(target, message.choice.options);
          if (!message.choice.saveAs) {
            changes = 0;
            replies.push({ type: 'metadata', data: metadata }, { type: 'changed', changes });
            if (message.choice.options.sort || message.choice.options.filters || !message.choice.options.edits) replies.push({ type: 'viewReset' });
          }
        }
        replies.push({ type: 'response', id: message.id }, { type: 'response', id: saveId });
        return replies;
      }
      else if (message.type === 'header') {
        await file.dispose();
        let indexed!: () => void;
        const complete = new Promise<void>(resolve => { indexed = resolve; });
        file = new CsvFile(path, data => { metadata = data; if (data.complete) indexed(); }, undefined, { hasHeader: message.enabled });
        const early = await file.open(); await complete;
        // Indexing finishes while settings persist, so an earlier response arrives afterward.
        return [{ type: 'metadata', data: metadata }, { type: 'changed', changes }, { type: 'response', id: message.id, result: { ...early, complete: false } }];
      }
      else if (message.type === 'versions') { const versions = message.scope === 'all' ? await history.listAll() : await history.list(path); result = { versions, bytes: versions.reduce((sum, entry) => sum + entry.bytes, 0), totalBytes: await history.usage() }; }
      else if (message.type === 'clearVersions') { await history.clear(message.scope === 'all' ? undefined : path); result = { cleared: true }; }
      else if (message.type === 'recover') {
        const snapshot = await history.get(message.source ?? path, message.version);
        if (message.saveAs) await copyFile(snapshot.path, join(directory, 'recovered.csv'));
        else {
          await file.dispose(); await copyFile(snapshot.path, path);
          file = new CsvFile(path, data => { metadata = data; }, undefined, { hasHeader: snapshot.version.hasHeader });
          await file.open();
          return [{ type: 'metadata', data: metadata }, { type: 'viewReset' }, { type: 'response', id: message.id }];
        }
      }
      else if (message.type === 'copy') result = await file.copy(message.start, message.count, message.columns, message.ranges, message.cells, message.includeHeaders);
      else if (message.type === 'stats') { statsRequests++; result = await file.stats(message.start, message.count, message.columns, message.ranges, message.cells); }
      else if (message.type === 'openLink') links.push(message.url);
      else throw new Error(`Unhandled test host request: ${message.type}`);
      const replies: HostMessage[] = [{ type: 'response', id: message.id, result }];
      if (message.type === 'ready' || message.type === 'language') replies.unshift({ type: 'language', language });
      if (message.type === 'textEdit') replies.unshift({ type: 'metadata', data: metadata }, { type: 'changed', changes });
      if (message.type === 'edit') replies.push({ type: 'changed', changes, canUndo: undoPosition > 0, canRedo: undoPosition < undoTokens.length });
      return replies;
    } catch (error) { return [{ type: 'response', id: message.id, error: String(error) }]; }
  });
  await mountGrid(page);
});

async function mountGrid(page: Page, firstValue = 'Product 600'): Promise<void> {
  await page.setContent('<html><body class="vscode-dark"><div id="app"></div></body></html>');
  await page.addStyleTag({ content: '@layer vscode-default { html { --vscode-editor-font-family: Menlo, Monaco, \'Courier New\', monospace; --vscode-scrollbarSlider-background: rgba(100, 100, 100, .4); --vscode-editor-background: rgb(30, 30, 30); scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); } }' });
  await page.addStyleTag({ path: 'src/webview/style.css' });
  await page.addScriptTag({ content: `window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: async message => { for (const reply of await window.sendToHost(message)) window.postMessage(reply, '*'); } });` });
  await page.addScriptTag({ path: 'dist/grid.js' });
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText(firstValue);
}

async function replaceSource(page: Page, source: string, firstValue: string): Promise<void> {
  await file.dispose(); await writeFile(path, source);
  let indexed!: () => void;
  const complete = new Promise<void>(resolve => { indexed = resolve; });
  file = new CsvFile(path, data => { metadata = data; if (data.complete) indexed(); });
  await file.open(); await complete;
  changes = 0;
  await page.goto('about:blank'); await mountGrid(page, firstValue);
}

async function dragText(page: Page, selector: string, start: number, end: number, during?: () => Promise<void>): Promise<void> {
  const points = await page.locator(selector).evaluate((node, offsets) => {
    const text = node.firstChild!;
    return offsets.map(offset => {
      const range = document.createRange(); range.setStart(text, offset); range.collapse(true);
      const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y + rect.height / 2 };
    });
  }, [start, end]);
  await page.mouse.move(points[0]!.x, points[0]!.y); await page.mouse.down();
  await page.mouse.move((points[0]!.x + points[1]!.x) / 2, points[0]!.y, { steps: 3 });
  if (during) await during();
  await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 5 }); await page.mouse.up();
}

test.afterEach(async () => {
  hostPrompts?.dispose();
  releaseDistinct?.();
  await file?.dispose();
  await rm(directory, { recursive: true, force: true });
});

test('toolbar menus support keyboard commands and keep explained icons compact with theme last', async ({ page }) => {
  const view = page.getByRole('button', { name: 'View', exact: true });
  await view.focus(); await view.press('ArrowDown');
  await expect(page.getByRole('dialog', { name: 'View commands', exact: true }).getByRole('button', { name: 'Switch to Text mode', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Use first row as column headers' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Click: search, hide, or show columns' })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Clear filters, sorting, and column layout' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(view).toBeFocused();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'File commands' })).toBeVisible();
  const menuItems = await page.getByRole('dialog', { name: 'File commands' }).locator(':scope > button').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
  }));
  for (let index = 1; index < menuItems.length; index++) expect(menuItems[index]!.top - menuItems[index - 1]!.bottom).toBeCloseTo(0, 1);
  await page.locator('[data-index="5"][data-col="0"]').click();
  await expect(page.getByRole('dialog', { name: 'File commands' })).not.toBeVisible();
  expect(await page.locator('.toolbar > .icon-button').evaluateAll(buttons => buttons.every(button => Boolean(button.getAttribute('data-tooltip'))))).toBe(true);
  await expect(page.locator('.toolbar > button').last()).toHaveAttribute('aria-label', /Theme:/);
  await page.setViewportSize({ width: 360, height: 600 });
  expect(await page.locator('.toolbar').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await view.click();
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-toolbar-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Switch to light/ }).click();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-toolbar-light.png') });
});

test('toolbar menus require click activation, hover-switch while active, and deactivate on dismissal', async ({ page }) => {
  const fileMenu = page.getByRole('dialog', { name: 'File commands', exact: true });
  await page.getByRole('button', { name: 'File', exact: true }).hover();
  await expect(fileMenu).not.toBeVisible();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(fileMenu).toBeVisible();
  await fileMenu.getByRole('button', { name: 'Save (Ctrl/Cmd+S)', exact: true }).hover();
  await expect(fileMenu).toBeVisible();
  await page.locator('.cell[data-index="3"][data-col="3"]').hover();
  await expect(fileMenu).toBeVisible();
  await page.getByRole('button', { name: 'View', exact: true }).hover();
  await expect(page.getByRole('dialog', { name: 'View commands', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).hover();
  await expect(page.getByRole('dialog', { name: 'View commands', exact: true })).not.toBeVisible();
  const settings = page.getByRole('dialog', { name: 'Settings commands', exact: true });
  await settings.getByRole('button', { name: 'Language', exact: true }).hover();
  const languageRow = (await settings.getByRole('button', { name: 'Language', exact: true }).boundingBox())!;
  const englishRow = (await page.getByRole('menuitemradio', { name: 'English', exact: true }).boundingBox())!;
  expect(englishRow.y).toBeCloseTo(languageRow.y, 1);
  await expect(settings.getByRole('button', { name: 'Backup settings…', exact: true })).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  const chinese = page.getByRole('menuitemradio', { name: '简体中文', exact: true });
  const choice = (await chinese.boundingBox())!;
  await page.mouse.move(choice.x + choice.width / 2, choice.y + choice.height / 2, { steps: 12 });
  await expect(settings).toBeVisible(); await expect(chinese).toBeVisible();
  await page.locator('.cell[data-index="6"][data-col="3"]').hover();
  await expect(settings).toBeVisible(); await expect(chinese).toBeVisible();
  await page.locator('.cell[data-index="6"][data-col="3"]').click();
  await expect(settings).not.toBeVisible(); await expect(chinese).not.toBeVisible();
  await page.getByRole('button', { name: 'View', exact: true }).hover();
  await expect(page.getByRole('dialog', { name: 'View commands', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(fileMenu).not.toBeVisible();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).hover();
  await expect(settings).not.toBeVisible();
});

test('filter and sort buttons toggle their own popups and switch between columns', async ({ page }) => {
  const filter = page.getByRole('button', { name: 'Filter Amount', exact: true });
  const sort = page.getByRole('button', { name: 'Sort Amount', exact: true });
  const popup = page.locator('.column-menu');
  await filter.click(); await expect(popup).toHaveAttribute('aria-label', 'Column filter');
  await filter.click(); await expect(popup).toHaveCount(0);
  await sort.click(); await expect(popup).toHaveAttribute('aria-label', 'Sort options');
  await expect(popup.getByRole('group', { name: 'Sort direction', exact: true }).getByRole('button', { name: 'Original order', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(popup.getByRole('group', { name: 'Sort type', exact: true }).getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sort.click(); await expect(popup).toHaveCount(0);
  await sort.click(); await filter.click(); await expect(popup).toHaveAttribute('aria-label', 'Column filter');
  await page.getByRole('button', { name: 'Filter Region', exact: true }).click();
  await expect(popup).toHaveAttribute('data-column', '4');
  await page.getByRole('button', { name: 'Filter Region', exact: true }).click(); await expect(popup).toHaveCount(0);
});

test('View menu exposes mode, theme, and guide actions and Data exposes selection calculation', async ({ page }) => {
  const view = page.getByRole('dialog', { name: 'View commands', exact: true });
  const openView = () => page.getByRole('button', { name: 'View', exact: true }).click();
  await openView(); await view.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'CSV source' })).toBeVisible();
  const before = await page.locator('html').getAttribute('data-theme');
  await openView(); await view.getByRole('button', { name: 'Switch color theme', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', before!);
  await openView(); await view.getByRole('button', { name: 'Click: start the guided tour', exact: true }).click();
  await expect(page.locator('.quick-guide')).toBeVisible();
  await page.locator('.quick-guide').getByRole('button', { name: 'Skip', exact: true }).click();
  await page.locator('.guide-reminder').getByRole('button', { name: 'Got it', exact: true }).click();
  await openView(); await view.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  await expect(page.locator('.viewport')).toBeVisible();
  await page.locator('.cell[data-index="0"][data-col="3"]').click();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const data = page.getByRole('dialog', { name: 'Data commands', exact: true });
  await data.getByRole('button', { name: 'Calculate selection', exact: true }).click();
  await expect(page.locator('.status')).toContainText('AVG');
});

test('toolbar operation hints coexist with native button titles while cells keep operation-only hints', async ({ page }) => {
  const hint = page.locator('.toolbar-hint');
  const help = page.getByRole('button', { name: 'Help: Quick guide' });
  await help.hover();
  await expect(hint).toHaveText('Tips: Click: start the guided tour', { timeout: 800 });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(help).toHaveAttribute('title', 'Click: start the guided tour');
  await page.mouse.move(0, 0); await help.blur();
  await expect(hint).toHaveText('');
  await help.focus(); await expect(hint).toHaveText('Tips: Click: start the guided tour');
  await expect(help).toHaveAttribute('title', 'Click: start the guided tour');
  await help.blur();
  const cell = page.locator('[data-index="0"][data-col="0"]');
  await cell.hover(); await expect(hint).toContainText('Tips: Click and drag: select cells');
  await cell.click(); await expect(hint).toContainText('Tips: Click and drag: select cells');
  await expect(hint).toHaveText('Tips: Click and drag: select cells | Double-click: edit | Right-click: options');
  await expect(cell).not.toHaveAttribute('title');
  const toolbar = (await page.locator('.toolbar').boundingBox())!;
  const bounds = (await hint.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(toolbar.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole('button', { name: /Switch to light/ }).hover();
  await expect(hint).toContainText('Click: switch to light theme');
  const theme = page.getByRole('button', { name: /Switch to light/ });
  await expect(theme).toHaveAttribute('title', 'Click: switch to light theme');
  await theme.click();
  await expect(page.getByRole('button', { name: /Switch to dark/ })).toHaveAttribute('title', 'Click: switch to dark theme');
  expect(await page.locator('.toolbar').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('edited cells keep an unsaved mark through selection and sorting and clear on revert or save', async ({ page }) => {
  const cell = () => page.locator('.cell[data-row="0"][data-col="0"]');
  const edit = async (value: string) => {
    await cell().dblclick(); await page.getByRole('textbox', { name: 'Cell value' }).fill(value);
    await page.getByRole('textbox', { name: 'Cell value', exact: true }).press('Enter');
  };
  await edit('Changed'); await expect(cell()).toHaveClass(/modified/);
  await expect(page.locator('.cell.modified')).toHaveCount(1);
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  await expect(cell()).toHaveClass(/modified/);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-unsaved-dark.png') });
  await edit('Product 600'); await expect(page.locator('.cell.modified')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  await expect(cell()).toBeVisible();
  await edit('Z changed'); await expect(cell()).toHaveClass(/modified/);
  await page.getByRole('button', { name: /Switch to light/ }).click();
  await page.locator('.cell[data-index="1"][data-col="0"]').click();
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-unsaved-light.png') });
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect(page.locator('.cell.modified')).toHaveCount(0);
  expect(await readFile(path, 'utf8')).toContain('Z changed,');
});

test('multiple filters mark only their icons while sorting belongs to one column', async ({ page }) => {
  const label = page.locator('.column-heading[data-col="0"] .column-label');
  const originalColor = await label.evaluate(node => getComputedStyle(node).color);
  await numberFilter(page, 'Amount', 'gte', '598');
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter column by text' }).fill('001');
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '1');
  await expect(page.locator('.column-filter-button[aria-pressed="true"]')).toHaveCount(2);
  await expect(label).toHaveCSS('color', originalColor);
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  await expect(page.locator('.column-sort-button[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('.column-heading[data-col="0"]')).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('.column-filter-button[aria-pressed="true"]')).toHaveCount(2);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-applied-dark.png') });
  await page.getByRole('button', { name: /Switch to light/ }).click();
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-applied-light.png') });
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  await page.getByRole('button', { name: 'Reset column filter', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '2');
  await expect(page.locator('.column-filter-button[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Filter Amount', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('sorted edits save to the original row and preserve file order', async ({ page }) => {
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  const first = page.locator('[data-index="0"][data-col="0"]');
  await expect(first).toHaveText('Product 001');
  await first.dblclick();
  await expect(page.getByRole('group', { name: 'Edit Product #600', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Cell value' }).fill('Updated');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).press('Enter');
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect.poll(() => readFile(path, 'utf8')).toContain('Updated,"line one\nline two",https://example.com/599');
  const saved = await readFile(path, 'utf8');
  expect(saved.indexOf('Product 600')).toBeLessThan(saved.indexOf('Updated'));
  expect(saved).toContain('Updated,"line one\nline two",https://example.com/599');
});

test('row number and frozen cells stay fixed synchronously during horizontal scrolling', async ({ page }) => {
  await columnMenu(page, 'Product');
  await page.getByRole('dialog', { name: 'Column options' }).getByRole('button', { name: 'Pin to left', exact: true }).click();
  const positions = await page.evaluate(() => {
    const viewport = document.querySelector('.viewport')!;
    const x = () => ['.row-number', '.cell.frozen'].map(selector => document.querySelector(selector)!.getBoundingClientRect().x);
    const before = x(); viewport.scrollLeft = 300;
    return { before, after: x() };
  });
  expect(positions.after).toEqual(positions.before);
  await page.locator('.viewport').evaluate(node => { node.scrollLeft = 0; });
  await expect(page.locator('[data-index="0"][data-col="1"]')).toBeVisible();
  await selectRectangle(page, 0, 1, 2, 2);
  await expect(page.locator('.cell.frozen').first()).toHaveCSS('box-shadow', 'none');
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-headless-pin-selection.png') });
});

test('column drag inserts at the indicated boundary and uses move semantics', async ({ page }) => {
  await page.locator('.viewport').evaluate(node => { node.scrollTop = 85; });
  await expect(page.locator('[data-index="3"][data-col="0"]')).toBeVisible();
  const amount = page.locator('.column-heading[data-col="3"]');
  // A pending scroll render may replace the heading; capture visible geometry only.
  let box!: { x: number; y: number; width: number; height: number };
  await expect.poll(async () => { const bounds = await amount.boundingBox(); if (bounds) box = bounds; return Boolean(bounds && bounds.width > 0 && bounds.height > 0); }).toBe(true);
  await page.evaluate(() => document.addEventListener('dragstart', event => {
    document.body.dataset.dragEffect = event.dataTransfer?.effectAllowed;
  }));
  const move = page.getByRole('button', { name: 'Move Product', exact: true });
  await expect(move).toBeVisible();
  let source!: { x: number; y: number; width: number; height: number };
  await expect.poll(async () => { const bounds = await move.boundingBox(); if (bounds) source = bounds; return Boolean(bounds && bounds.width > 0 && bounds.height > 0); }).toBe(true);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + 15, { steps: 10 });
  await page.mouse.move(box.x + box.width - 9, box.y + 15);
  await expect(page.locator('body')).toHaveAttribute('data-drag-effect', 'move');
  await expect(amount).toHaveClass(/drop-after/);
  await expect(page.locator('.column-drag-image .cell')).not.toHaveCount(0);
  const preview = await page.evaluate(() => {
    const image = document.querySelector<HTMLElement>('.column-drag-image')!;
    const viewport = document.querySelector<HTMLElement>('.viewport')!;
    const header = document.querySelector<HTMLElement>('.column-headings')!;
    const body = image.querySelector<HTMLElement>('.column-drag-body')!;
    const viewportRect = viewport.getBoundingClientRect();
    const rows = Array.from(body.querySelectorAll<HTMLElement>('.cell')).map(cell => {
      const original = document.querySelector<HTMLElement>(`.grid-canvas [data-index="${cell.dataset.index}"][data-col="0"]`)!;
      return { original: original.getBoundingClientRect().top - viewportRect.top, copy: Number.parseFloat(cell.style.top), height: cell.getBoundingClientRect().height, originalHeight: original.getBoundingClientRect().height };
    });
    return { height: image.getBoundingClientRect().height, maxHeight: header.getBoundingClientRect().height + viewport.clientHeight, opacity: Number(getComputedStyle(image).opacity), overflow: getComputedStyle(body).overflow, rows };
  });
  expect(preview.height).toBeLessThanOrEqual(preview.maxHeight);
  expect(preview.opacity).toBeLessThan(0.5);
  expect(preview.overflow).toBe('hidden');
  expect(preview.rows.some(row => row.original < 0)).toBe(true);
  for (const row of preview.rows) { expect(row.copy).toBeCloseTo(row.original, 1); expect(row.height).toBe(row.originalHeight); }
  await page.mouse.up();
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('Note');
  expect((await file.page(0, 1)).rows[0].values.slice(0, 4)).toEqual(['line one\nline two', 'https://example.com/0', '0', 'Product 600']);
  await expect.poll(() => page.evaluate(() => {
    const a = document.querySelector('.column-heading[data-col="3"]'), b = document.querySelector('.column-heading[data-col="4"]');
    return Boolean(a && b && getComputedStyle(a).backgroundColor === getComputedStyle(b).backgroundColor);
  })).toBe(true);
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click();
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('Product');
  await page.getByRole('button', { name: 'Redo (Ctrl/Cmd+Shift+Z)', exact: true }).click();
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
});

test('dragging cell text or URLs selects cells while a single URL click opens externally', async ({ page }) => {
  await selectRectangle(page, 0, 0, 2, 1);
  await expect(page.locator('.cell.selected')).toHaveCount(6);
  const text = page.locator('[data-index="0"][data-col="0"] .cell-text');
  const from = (await text.boundingBox())!, to = (await page.locator('[data-index="2"][data-col="1"]').boundingBox())!;
  await page.mouse.move(from.x + 10, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + 15, to.y + to.height / 2, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.cell.selected')).toHaveCount(6);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await page.locator('[data-index="0"][data-col="2"] a').click();
  await expect.poll(() => links).toEqual(['https://example.com/0']);
  await dragText(page, '[data-index="0"][data-col="2"] a', 1, 8);
  await expect(page.locator('.cell.selected')).toHaveCount(1);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  expect(links).toEqual(['https://example.com/0']);
});

test('mixed text detects separate URLs and punctuation while URL dragging selects a cell without opening', async ({ page }) => {
  const mixed = '见：https://example.com，请查看 https://example.org/help。另见 https://example.net/中文/指南。';
  const complete = 'https://example.com/' + 'a'.repeat(600);
  const unknown = 'https://example.com/' + 'b'.repeat(5000);
  const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  await replaceSource(page, 'Note,Number\n' + [[mixed, '1'], ['x'.repeat(970) + ' ' + complete + ' end', '2'], [unknown, '3']].map(row => row.map(quote).join(',')).join('\n') + '\n', mixed);
  const first = page.locator('.cell[data-index="0"][data-col="0"]');
  const anchors = first.locator('a'); await expect(anchors).toHaveCount(3);
  expect(await anchors.evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href))).toEqual([
    'https://example.com/', 'https://example.org/help', new URL('https://example.net/中文/指南').href,
  ]);
  await expect(first).toContainText('，请查看');
  await expect(page.locator('.cell[data-index="1"][data-col="0"] a')).toHaveAttribute('href', complete);
  await expect(page.locator('.cell[data-index="2"][data-col="0"] a')).toHaveCount(0);
  const link = anchors.first();
  await dragText(page, '.cell[data-index="0"][data-col="0"] a:first-of-type', 1, 8);
  const box = (await link.boundingBox())!;
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(first).toHaveClass(/selected/);
  expect(links).toEqual([]);
  await page.keyboard.press('ControlOrMeta+c'); await expect.poll(() => clipboardText).toBe(mixed);
  await page.locator('.cell[data-index="0"][data-col="1"]').click({ position: { x: 150, y: 15 } });
  await link.click({ position: { x: 5, y: box.height / 2 } });
  await expect.poll(() => links).toEqual(['https://example.com']);
});

test('column and multiline row borders support drag and double-click fit', async ({ page }) => {
  const column = page.locator('.column-heading[data-col="0"] .column-resize');
  const box = (await column.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 83, box.y + 15, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.column-heading[data-col="0"]')).toHaveCSS('width', '260px');
  await page.locator('.column-heading[data-col="0"] .column-resize').dblclick();
  await expect(page.locator('.column-heading[data-col="0"]')).not.toHaveCSS('width', '260px');
  const row = page.locator('.grid-row').first();
  const border = row.locator('.row-resize');
  await border.dblclick();
  await expect(row).toHaveCSS('height', '46px');
  const rowBox = (await row.locator('.row-resize').boundingBox())!;
  await page.mouse.move(rowBox.x + 20, rowBox.y + 2); await page.mouse.down();
  await page.mouse.move(rowBox.x + 20, rowBox.y + 52, { steps: 5 }); await page.mouse.up();
  await expect(row).toHaveCSS('height', '96px');
});

test('filtering finds rows without changing the file and reset restores the full view', async ({ page }) => {
  const source = await readFile(path, 'utf8');
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter column by text' }).fill('Product 001');
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 001');
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '1');
  await toolbarCommand(page, 'View', 'Clear filters, sorting, and column layout');
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 600');
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '600');
  expect(await readFile(path, 'utf8')).toBe(source);
});

test('themes work in a narrow window with a bounded number of rendered cells', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 500 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Theme: VS Code · Switch to light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-headless-light.png') });
  await page.getByRole('button', { name: 'Theme: light · Switch to dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
  expect(await page.locator('[role="gridcell"]').count()).toBeLessThan(100);
  const viewport = (await page.locator('.viewport').boundingBox())!;
  expect(viewport.height).toBeGreaterThan(400);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-headless-dark.png') });
  const icons = await page.locator('.column-heading[data-col="0"] button').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect(), icon = button.querySelector('svg')!.getBoundingClientRect();
    return { width: box.width, height: box.height, iconWidth: icon.width, iconHeight: icon.height, dx: icon.x + icon.width / 2 - box.x - box.width / 2, dy: icon.y + icon.height / 2 - box.y - box.height / 2 };
  }));
  expect(icons).toHaveLength(3);
  for (const icon of icons) {
    expect(icon.width).toBe(22); expect(icon.height).toBe(22);
    expect(icon.iconWidth).toBe(13); expect(icon.iconHeight).toBe(13);
    expect(icon.dx).toBeCloseTo(0, 1); expect(icon.dy).toBeCloseTo(0, 1);
  }
  await columnMenu(page, 'Product');
  const menu = (await page.getByRole('dialog', { name: 'Column options' }).boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(420);
  expect(menu.y).toBeGreaterThanOrEqual(0); expect(menu.y + menu.height).toBeLessThanOrEqual(500);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-headless-dark-menu.png') });
});

async function columnMenu(page: Page, name: string): Promise<void> {
  await page.getByRole('columnheader').filter({ has: page.locator('.column-label', { hasText: new RegExp(`^${name}$`) }) }).click({ button: 'right' });
}

async function numberFilter(page: Page, column: string, operator: string, value: string, maximum?: string): Promise<void> {
  await page.getByRole('button', { name: `Filter ${column}`, exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('number');
  await page.getByRole('combobox', { name: 'Number comparison', exact: true }).selectOption(operator);
  await page.getByRole('spinbutton', { name: 'Filter number', exact: true }).fill(value);
  if (maximum !== undefined) await page.getByRole('spinbutton', { name: 'Filter maximum', exact: true }).fill(maximum);
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
}

async function selectRectangle(page: Page, firstRow: number, firstCol: number, lastRow: number, lastCol: number): Promise<void> {
  const firstCell = page.locator(`[data-index="${firstRow}"][data-col="${firstCol}"]`);
  const lastCell = page.locator(`[data-index="${lastRow}"][data-col="${lastCol}"]`);
  let first: Awaited<ReturnType<typeof firstCell.boundingBox>>;
  let last: Awaited<ReturnType<typeof lastCell.boundingBox>>;
  await expect.poll(async () => { first = await firstCell.boundingBox(); last = await lastCell.boundingBox(); return Boolean(first && last); }).toBe(true);
  await page.mouse.move(first!.x + first!.width - 10, first!.y + 15); await page.mouse.down();
  await page.mouse.move(last!.x + last!.width - 10, last!.y + 15, { steps: 6 }); await page.mouse.up();
}

async function expectColumnStart(page: Page, column: number, values: string[]): Promise<void> {
  for (let index = 0; index < values.length; index++) {
    await expect(page.locator(`[data-index="${index}"][data-col="${column}"]`)).toHaveText(values[index]);
  }
}

test('automatic sorting recognizes numeric columns and a text value anywhere in a mixed column', async ({ page }) => {
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await expectColumnStart(page, 3, ['0', '1', '2']);
  await page.getByRole('button', { name: 'Sort Region', exact: true }).dblclick();
  await expectColumnStart(page, 4, ['10', '2', 'Asia']);
  // Only numeric values remain visible, but auto detection still inspects the original full column.
  await numberFilter(page, 'Region', 'lte', '10');
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '2');
  await expectColumnStart(page, 4, ['10', '2']);
});

test('sort icon context menu changes direction and numeric or text sorting', async ({ page }) => {
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).click({ button: 'right' });
  await page.getByRole('group', { name: 'Sort type', exact: true }).getByRole('button', { name: 'Text', exact: true }).click();
  await expectColumnStart(page, 3, ['0', '1', '10']);
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).click({ button: 'right' });
  await page.getByRole('group', { name: 'Sort type', exact: true }).getByRole('button', { name: 'Number', exact: true }).click();
  await expectColumnStart(page, 3, ['0', '1', '2']);
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).click({ button: 'right' });
  const menu = page.getByRole('dialog', { name: 'Sort options', exact: true });
  await menu.getByRole('button', { name: 'Descending', exact: true }).click();
  await expectColumnStart(page, 3, ['599', '598', '597']);
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).click({ button: 'right' });
  await menu.getByRole('button', { name: 'Original order', exact: true }).click();
  await expectColumnStart(page, 3, ['0', '1', '2']);
});

test('double-clicking a column drag handle toggles Pin without editing source column order', async ({ page }) => {
  const source = await readFile(path, 'utf8');
  await page.getByRole('button', { name: 'Move Amount', exact: true }).dblclick();
  await expect(page.locator('.column-heading[data-col]').first()).toHaveAttribute('data-col', '3');
  await expect(page.locator('.cell.frozen[data-col="3"]').first()).toBeVisible();
  expect(file.changes).toBe(0); expect(await readFile(path, 'utf8')).toBe(source);
  await page.getByRole('button', { name: 'Move Amount', exact: true }).dblclick();
  await expect(page.locator('.column-heading[data-col]').first()).toHaveAttribute('data-col', '0');
  await expect(page.locator('.cell.frozen')).toHaveCount(0);
  expect((await file.textPage(0, 1)).text).toMatch(/^Product,Note,Link,Amount/);
});

test('single click opens sort choices and double click cycles directions while retaining filters', async ({ page }) => {
  const source = await readFile(path, 'utf8');
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Sort options', exact: true });
  await expect(menu).toBeVisible();
  await expect(page.locator('.column-heading[data-col="3"]')).not.toHaveAttribute('aria-sort');
  await expect(menu.getByRole('group', { name: 'Sort type', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await readFile(path, 'utf8')).toBe(source);
  await numberFilter(page, 'Amount', 'gte', '598');
  const heading = page.locator('.column-heading[data-col="3"]');
  const sort = page.getByRole('button', { name: 'Sort Amount', exact: true });
  await sort.dblclick();
  await expect(heading).toHaveAttribute('aria-sort', 'ascending');
  await expectColumnStart(page, 3, ['598', '599']);
  await sort.dblclick();
  await expect(heading).toHaveAttribute('aria-sort', 'descending');
  await expectColumnStart(page, 3, ['599', '598']);
  await sort.dblclick();
  await expect(heading).not.toHaveAttribute('aria-sort');
  await expectColumnStart(page, 3, ['598', '599']);
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '2');
});

test('numeric filters compare values and include both range endpoints', async ({ page }) => {
  await numberFilter(page, 'Amount', 'gt', '597');
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '2');
  await expectColumnStart(page, 3, ['598', '599']);
  await numberFilter(page, 'Amount', 'between', '2', '10');
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '9');
  await expectColumnStart(page, 3, ['2', '3', '4']);
  await expect(page.locator('[data-index="8"][data-col="3"]')).toHaveText('10');
  await page.getByRole('button', { name: 'Filter Amount', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Filter maximum', exact: true }).fill('1');
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '9');
});

test('empty filters include whitespace and nonempty excludes it', async ({ page }) => {
  await page.getByRole('button', { name: 'Filter Region', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('empty');
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '2');
  await expectColumnStart(page, 0, ['Product 598', 'Product 597']);
  await page.getByRole('button', { name: 'Filter Region', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('notEmpty');
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '598');
  await expectColumnStart(page, 0, ['Product 600', 'Product 599', 'Product 596']);
});

test('small loaded selections calculate automatically while unloaded selections keep Calculate', async ({ page }) => {
  await selectRectangle(page, 0, 3, 2, 4);
  await expect(page.locator('.status')).toContainText('3 rows × 2 columns');
  await expect(page.locator('.status')).toContainText('Sum 15 · AVG 3');
  await expect(page.locator('.status')).toContainText('Min 0 · Max 10');
  expect(statsRequests).toBe(1);
  await expect(page.getByRole('button', { name: 'Calculate selection', exact: true })).toBeHidden();
  await expect(page.locator('.status-total')).toContainText('Total rows: 600');
  await page.locator('.column-heading[data-col="3"] .column-label').click();
  await expect(page.locator('.status')).toContainText('600 rows × 1 columns');
  await page.waitForTimeout(300);
  expect(statsRequests).toBe(1);
  const calculate = page.getByRole('button', { name: 'Calculate selection', exact: true });
  await expect(calculate).toBeVisible();
  expect((await calculate.boundingBox())!.x).toBeGreaterThan((await page.locator('.selection-summary').boundingBox())!.x);
  await calculate.click();
  await expect(page.locator('.status')).toContainText('Sum 179,700 · AVG 299.5');
  await expect(calculate).toBeEnabled();
  await calculate.click();
  await expect.poll(() => statsRequests).toBe(3);
  await expect(calculate).toBeEnabled();
});

test('selection statistics follow filtered sorted rows and reordered columns', async ({ page }) => {
  await numberFilter(page, 'Amount', 'gte', '598');
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await expectColumnStart(page, 3, ['599', '598']);
  const source = (await page.getByRole('button', { name: 'Move Amount', exact: true }).boundingBox())!;
  const target = (await page.locator('.column-heading[data-col="4"]').boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.mouse.move(target.x + target.width - 10, target.y + 15, { steps: 10 });
  await page.mouse.move(target.x + target.width - 9, target.y + 15); await page.mouse.up();
  await expect(page.locator('.column-heading[data-col="4"] .column-label')).toHaveText('Amount');
  await numberFilter(page, 'Amount', 'gte', '598');
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await expectColumnStart(page, 4, ['598', '599']);
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await expectColumnStart(page, 4, ['599', '598']);
  await page.locator('.viewport').evaluate(node => { node.scrollLeft = 220; });
  await expect(page.locator('.cell[data-index="0"][data-col="4"]')).toBeVisible();
  await selectRectangle(page, 0, 4, 1, 3);
  await expect(page.locator('.status')).toContainText('2 rows × 2 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 1,197 · AVG 598.5');
});

test('clicking and modifier-clicking headers select full columns beyond rendered rows and toggle disjoint columns', async ({ page }) => {
  await page.locator('.column-heading[data-col="3"] .column-label').click();
  await expect(page.locator('.status')).toContainText('600 rows × 1 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 179,700 · AVG 299.5');
  await page.locator('.column-heading[data-col="0"] .column-label').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.status')).toContainText('600 rows × 2 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 179,700 · AVG 299.5');
  await page.locator('.column-heading[data-col="3"] .column-label').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.status')).toContainText('600 rows × 1 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 0 · AVG —');
});

test('row numbers select full rows and modifier-click toggles nonadjacent rows', async ({ page }) => {
  await page.locator('.row-number[data-index="0"]').click();
  await expect(page.locator('.status')).toContainText('1 rows × 7 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 10 · AVG 5');
  await page.locator('.row-number[data-index="2"]').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.status')).toContainText('2 rows × 7 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 12 · AVG 4');
  await page.locator('.row-number[data-index="0"]').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.status')).toContainText('1 rows × 7 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 2 · AVG 2');
});

test('dragging header labels and row numbers selects contiguous whole columns and rows', async ({ page }) => {
  const start = (await page.locator('.column-heading[data-col="0"] .column-label').boundingBox())!;
  const end = (await page.locator('.column-heading[data-col="1"] .column-label').boundingBox())!;
  await page.mouse.move(start.x + 10, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(end.x + 10, end.y + end.height / 2, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.status')).toContainText('600 rows × 2 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 0 · AVG —');
  expect(await page.locator('.column-heading[data-col]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.col))).toEqual(['0', '1', '2', '3', '4', '5']);
  const first = (await page.locator('.row-number[data-index="0"]').boundingBox())!;
  const last = (await page.locator('.row-number[data-index="2"]').boundingBox())!;
  await page.mouse.move(first.x + first.width - 20, first.y + 12); await page.mouse.down();
  await page.mouse.move(last.x + last.width - 20, last.y + 12, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.status')).toContainText('3 rows × 7 columns');
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 15 · AVG 3');
});


test('header remains switchable after delayed responses and preserves the first record', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Use first row as column headers', includeHidden: true });
  for (let i = 0; i < 8; i++) {
    await toolbarCommand(page, 'View', 'Use first row as column headers'); await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-pressed', String(i % 2 === 1));
    await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText(i % 2 === 0 ? 'Product' : 'Product 600');
  }
  expect(await readFile(path, 'utf8')).toContain('Product,Note,Link,Amount');
});

test('export writes sorted filtered visible columns while Save preserves rows and recovery retains original content', async ({ page }) => {
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Filter Product' }).click();
  await page.getByRole('textbox', { name: 'Filter column by text' }).fill('Product 00');
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.locator('.status-text')).toContainText('Filtered rows: 9');
  const source = await readFile(path, 'utf8');
  await toolbarCommand(page, 'File', 'Export filtered rows and visible columns to another CSV file');
  await expect(page.getByRole('dialog', { name: 'Save CSV' })).toBeHidden();
  await expect.poll(() => readFile(join(directory, 'export.csv'), 'utf8').catch(() => '')).toContain('Product 001');
  const exported = await readFile(join(directory, 'export.csv'), 'utf8');
  expect(exported).not.toContain('Product 600');
  expect(exported.indexOf('Product 001')).toBeLessThan(exported.indexOf('Product 009'));
  expect(await readFile(path, 'utf8')).toBe(source);
  await page.locator('.cell[data-index="0"][data-col="0"]').dblclick();
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Saved change');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).press('Enter');
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect.poll(() => readFile(path, 'utf8')).toContain('Saved change');
  await toolbarCommand(page, 'File', 'Recover a saved version');
  const recovery = page.getByRole('dialog', { name: 'Recover CSV' });
  await expect(recovery.getByRole('combobox', { name: 'Destination' })).toHaveValue('saveAs');
  await recovery.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect.poll(() => readFile(join(directory, 'recovered.csv'), 'utf8').catch(() => '')).toBe(source);
  expect(await readFile(path, 'utf8')).toContain('Saved change');
});

test('Save As writes a copy directly and retains unsaved source changes', async ({ page }) => {
  const source = await readFile(path, 'utf8');
  await page.locator('[data-index="0"][data-col="0"]').dblclick();
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Copy change');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).press('Enter');
  await toolbarCommand(page, 'File', 'Save content changes to another CSV file');
  await expect.poll(() => readFile(join(directory, 'copy.csv'), 'utf8').catch(() => '')).toContain('Copy change');
  expect(await readFile(path, 'utf8')).toBe(source); expect(changes).toBe(1);
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await expect(page.getByRole('dialog', { name: 'Save CSV' })).toBeHidden();
  expect(await readFile(path, 'utf8')).toBe(source); expect(changes).toBe(1);
});

test('save prompt and recovery fit a narrow light workspace', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole('button', { name: /Switch to light/ }).click();
  await page.evaluate(() => window.postMessage({ type: 'savePrompt', saveAs: false, allowDiscard: true }, '*'));
  const dialog = page.getByRole('dialog', { name: 'Save CSV' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await toolbarCommand(page, 'File', 'Recover a saved version');
  await expect(page.getByRole('dialog', { name: 'Recover CSV' })).toContainText('No saved versions yet');
  await page.getByRole('dialog', { name: 'Recover CSV' }).getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('Recover browses old project paths, restores copies and clears only requested history', async ({ page }) => {
  const original = await readFile(path, 'utf8');
  const history = new VersionHistory(join(directory, 'history'));
  const oldPath = join(directory, 'old-project.csv'), oldSource = 'A,B\nold project,9\n';
  await history.capture(path, true); await writeFile(oldPath, oldSource); await history.capture(oldPath, true); await rm(oldPath);
  await toolbarCommand(page, 'File', 'Recover a saved version');
  const dialog = page.getByRole('dialog', { name: 'Recover CSV', exact: true });
  await expect(dialog.locator('.history-details')).toHaveText(path);
  await expect(dialog.locator('.history-usage')).toContainText('Total storage:');
  await dialog.getByRole('combobox', { name: 'Backup scope', exact: true }).selectOption('all');
  const versions = await history.listAll(), oldIndex = versions.findIndex(version => version.source === oldPath);
  await expect(dialog.getByRole('combobox', { name: 'Version', exact: true }).locator('option')).toHaveCount(2);
  await dialog.getByRole('combobox', { name: 'Version', exact: true }).selectOption(String(oldIndex));
  await expect(dialog.locator('.history-details')).toHaveText(oldPath);
  await expect(dialog.getByRole('combobox', { name: 'Destination' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect.poll(() => readFile(join(directory, 'recovered.csv'), 'utf8').catch(() => '')).toBe(oldSource);
  expect(await readFile(path, 'utf8')).toBe(original);
  await toolbarCommand(page, 'File', 'Recover a saved version');
  await dialog.getByRole('button', { name: 'Clear current file backups', exact: true }).click();
  await expect(dialog).toContainText('No saved versions yet');
  expect((await history.list(oldPath)).length).toBe(1);
  await dialog.getByRole('combobox', { name: 'Backup scope', exact: true }).selectOption('all');
  await expect(dialog.locator('.history-details')).toHaveText(oldPath);
  await dialog.getByRole('button', { name: 'Clear all backups', exact: true }).click();
  await expect(dialog).toContainText('No saved versions yet');
  await expect(dialog.getByRole('button', { name: 'Recover', exact: true })).toBeDisabled();
  expect(await history.usage()).toBe(0); expect(await readFile(path, 'utf8')).toBe(original);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings commands', exact: true }).getByRole('button', { name: 'Backup settings…', exact: true }).click();
  await expect.poll(() => backupSettingsRequests).toBe(1);
});

test('filter button opens only filtering and the header context menu supports pinning and keyboard access', async ({ page }) => {
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  const filter = page.getByRole('dialog', { name: 'Column filter' });
  await expect(filter.getByRole('combobox', { name: 'Sort type' })).toHaveCount(0);
  await filter.getByRole('textbox', { name: 'Filter column by text' }).fill('Product 001');
  await filter.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '1');
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 001');
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Filter column by text' })).toHaveValue('Product 001');
  const actions = filter.locator('.menu-actions button:visible');
  await expect(actions).toHaveText(['Reset', 'Apply']);
  await actions.first().click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '600');
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  await expect(filter.getByRole('textbox', { name: 'Filter column by text' })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Filter Product', exact: true })).toBeFocused();
  await columnMenu(page, 'Product');
  const menu = page.getByRole('dialog', { name: 'Column options' });
  await expect(menu.getByRole('combobox', { name: 'Filter type' })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /Sort ascending|Sort descending|Clear sorting|Move column/ })).toHaveCount(0);
  await expect(menu.getByRole('combobox', { name: 'Sort type' })).toHaveCount(0);
  await menu.getByRole('button', { name: 'Pin to left', exact: true }).click();
  const header = page.locator('.column-heading[data-col="0"]');
  expect(await header.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Sort Product', 'Filter Product', 'Move Product']);
  await expect(header).toHaveClass(/frozen/);
  await header.focus(); await page.keyboard.press('Shift+F10');
  await menu.getByRole('button', { name: 'Unpin column', exact: true }).click();
  await expect(header).not.toHaveClass(/frozen/);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-headless-compact-headers.png') });
});

test('Text switches within the document, highlights CSV columns and toggles alignment without changing source', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  await expect(editor).toContainText('Product 600');
  await expect(page.locator('.csv-text-column-1').first()).toHaveText('Note');
  await expect(page.locator('.csv-text-column-1').nth(1)).toContainText('line one');
  const commaPositions = () => page.locator('.cm-line').evaluateAll(lines => lines.slice(0, 8).filter(line => line.querySelector('.csv-text-column-0')).map(line => line.querySelector('.csv-text-delimiter')?.getBoundingClientRect().x).filter(x => x !== undefined));
  const aligned = await commaPositions(); expect(Math.max(...aligned) - Math.min(...aligned)).toBeLessThan(1);
  const before = await editor.innerText();
  await editor.click(); await editor.press('ControlOrMeta+a');
  const copied = await editor.evaluate(node => { const data = new DataTransfer(); node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true })); return data.getData('text/plain'); });
  expect(copied).toBe((await file.textPage(0, 200)).text);
  await editor.press('ArrowLeft');
  await page.getByRole('checkbox', { name: 'Align', exact: true }).uncheck();
  await expect(page.locator('.csv-alignment-space')).toHaveCount(0);
  const natural = await commaPositions(); expect(Math.max(...natural) - Math.min(...natural)).toBeGreaterThan(10);
  expect(await editor.innerText()).toBe(before);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-text-unaligned.png') });
  await page.getByRole('checkbox', { name: 'Align', exact: true }).check();
  await page.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 001');
  expect(errors).toEqual([]);
});

test('Text multiline folding synchronizes both controls and preserves source, editing, and alignment', async ({ page }) => {
  await file.dispose();
  const source = 'ID,Note,Last\r\n1,"hello\n世界",tail\r\n2,"one\r\ntwo\r\nthree",end\r\n';
  await writeFile(path, source);
  file = new CsvFile(path, value => { metadata = value; }); await file.open(); await expect.poll(() => metadata.complete).toBe(true);
  await page.goto('about:blank'); await mountGrid(page, '1');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const folded = page.getByRole('checkbox', { name: 'Fold multiline', exact: true });
  await expect(folded).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Align', exact: true })).toBeChecked();
  await expect(page.locator('.csv-folded-newline')).toHaveCount(3);
  await expect(page.locator('.text-error')).not.toBeVisible();
  const delimiters = await page.locator('.csv-text-delimiter').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y };
  }));
  const rows = [...new Set(delimiters.map(rect => rect.y))];
  expect(rows).toHaveLength(3);
  for (const col of [0, 1]) {
    const positions = rows.map(y => delimiters.filter(rect => rect.y === y)[col]!.x);
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
  }
  expect((await file.textPage(0, 200)).text).toBe(source);
  expect(file.changes).toBe(0);
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  await editor.focus(); await editor.press('ControlOrMeta+a');
  const copied = await editor.evaluate(node => {
    const data = new DataTransfer(); node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true })); return data.getData('text/plain');
  });
  expect(copied.replace(/\r\n/g, '\n')).toBe(source.replace(/\r\n/g, '\n'));
  await editor.press('ArrowLeft');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'View commands', exact: true });
  const toggle = menu.getByRole('button', { name: /show each CSV record on one line/ });
  const alignToggle = menu.getByRole('button', { name: 'Click: align CSV columns visually without changing the file', exact: true });
  await expect(alignToggle).toHaveAttribute('aria-pressed', 'true');
  await alignToggle.click();
  await expect(page.getByRole('checkbox', { name: 'Align', exact: true })).not.toBeChecked();
  await expect(page.locator('.csv-alignment-space')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Align', exact: true }).check();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(alignToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(folded).not.toBeChecked();
  await expect(page.locator('.csv-folded-newline')).toHaveCount(0);
  await editor.focus(); await editor.press('ControlOrMeta+Home'); await editor.pressSequentially('X');
  await expect.poll(() => file.textPage(0, 200).then(value => value.text)).toBe('X' + source);
  await folded.check();
  await editor.focus(); await editor.press('ControlOrMeta+Home'); await editor.press('Delete');
  await expect.poll(() => file.textPage(0, 200).then(value => value.text)).toBe(source);
  await page.getByRole('checkbox', { name: 'Align', exact: true }).uncheck();
  await expect(page.locator('.csv-folded-newline')).toHaveCount(3);
  await page.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  expect((await file.page(0, 2)).rows.map(row => row.values[1])).toEqual(['hello\n世界', 'one\r\ntwo\r\nthree']);
  expect(await readFile(path, 'utf8')).toBe(source);
});

test('folded Text block editing selects visual records instead of hidden continuation lines', async ({ page }) => {
  await file.dispose();
  const source = 'ID,Note\n1,"alpha\nfirst"\n2,"bravo\nsecond"\n3,"charl\nthird"\n';
  await writeFile(path, source);
  file = new CsvFile(path, value => { metadata = value; }); await file.open();
  await page.goto('about:blank'); await mountGrid(page, '1');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Fold multiline', exact: true }).check();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  for (const aligned of [true, false]) {
    if (!aligned) await page.getByRole('checkbox', { name: 'Align', exact: true }).uncheck();
    const point = async (line: number, end: boolean) => page.locator('.cm-line').nth(line).evaluate((node, end) => {
      const text = node.querySelector('.csv-text-column-0')!.firstChild!;
      const range = document.createRange(); range.setStart(text, end ? 1 : 0); range.collapse(true);
      const box = range.getBoundingClientRect(); return { x: box.x, y: box.y + box.height / 2 };
    }, end);
    const start = await point(1, false), end = await point(3, true);
    await page.keyboard.down('Alt'); await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Alt');
    await expect(page.locator('.cm-cursor')).toHaveCount(3);
    await editor.pressSequentially(aligned ? '9' : '8');
    const expected = source.replace(/^[123],/gm, aligned ? '9,' : '8,');
    await expect.poll(() => file.textPage(0, 200).then(value => value.text)).toBe(expected);
    await editor.press('Escape');
  }
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-folded-text.png') });
  expect(await readFile(path, 'utf8')).toBe(source);
});

test('folded Text loads further multiline records without changing the file', async ({ page }) => {
  await file.dispose();
  const source = 'ID,Note\n' + Array.from({ length: 620 }, (_, index) => `${index + 1},"hello\nworld"\n`).join('');
  await writeFile(path, source);
  file = new CsvFile(path, value => { metadata = value; }); await file.open();
  await page.goto('about:blank'); await mountGrid(page, '1');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Fold multiline', exact: true }).check();
  for (const start of [200, 400, 600]) {
    await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => [...textRequests]).toContain(start);
    await expect(page.locator('.text-error')).not.toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  expect(file.changes).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(source);
});

test('Text loads more rows while scrolling and keeps edits across appended content', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Fold multiline', exact: true }).uncheck();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  await expect(page.locator('.toolbar .text-align')).toBeVisible();
  const viewport = await page.locator('.cm-scroller').boundingBox();
  const toolbar = await page.locator('.toolbar').boundingBox();
  expect(viewport!.y).toBeCloseTo(toolbar!.y + toolbar!.height, 0);
  await editor.click(); await editor.press('ControlOrMeta+Home'); await editor.pressSequentially('X');
  await expect.poll(() => file.textPage(0, 1).then(page => page.text)).toMatch(/^XProduct,/);
  for (const start of [200, 400, 600]) {
    await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => [...textRequests]).toContain(start);
    await expect(page.locator('.text-error')).not.toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(page.locator('.cm-line').filter({ hasText: 'Product 001' })).toBeVisible();
  await editor.press('ControlOrMeta+End'); await editor.press('ArrowUp'); await editor.press('Home'); await editor.pressSequentially('Y');
  await expect.poll(() => file.textPage(600, 1).then(page => page.text)).toContain('Yline two');
  await page.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('XProduct');
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect.poll(() => readFile(path, 'utf8')).toContain('\nYline two"');
});

test('Text rolls its bounded buffer forward and backward without changing the file', async ({ page }) => {
  await file.dispose();
  const content = 'name,note\n' + Array.from({ length: 800 }, (_, i) => `row${i},${'x'.repeat(6000)}`).join('\n') + '\n';
  await writeFile(path, content); file = new CsvFile(path, data => { metadata = data; }); await file.open();
  await page.evaluate(data => window.postMessage({ type: 'metadata', data }, '*'), metadata);
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Align', exact: true }).uncheck();
  const scroller = page.locator('.cm-scroller');
  const count = textRequests.length;
  await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => textRequests.length).toBeGreaterThan(count);
  await expect(page.locator('.text-error')).not.toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const forward = textRequests.at(-1)!;
  expect(forward).toBeGreaterThan(0);
  const loaded = textRequests.length;
  await scroller.evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => textRequests.length).toBeGreaterThan(loaded);
  expect(textRequests.at(-1)!).toBeLessThan(forward);
  await expect(page.locator('.text-error')).not.toBeVisible();
  expect(changes).toBe(0); expect(await readFile(path, 'utf8')).toBe(content);
});

test('Text drag scroll accelerates outside the editor and the selected word stays visible', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  const word = page.locator('.cm-line').filter({ hasText: 'Product 600' }).first();
  await word.dblclick({ position: { x: 20, y: 10 } });
  await expect(page.locator('.cm-selectionBackground').first()).toBeVisible();
  await expect(page.locator('.cm-selectionBackground').first()).toHaveCSS('background-color', 'rgb(40, 93, 145)');
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-text-selection.png') });
  await page.getByRole('button', { name: /Switch to light/ }).click();
  await expect(page.locator('.cm-selectionBackground').first()).toHaveCSS('background-color', 'rgb(173, 211, 255)');
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-text-selection-light.png') });
  await editor.press('Escape');
  const bounds = (await page.locator('.cm-scroller').boundingBox())!;
  const x = bounds.x + 90;
  await page.keyboard.down('Alt'); await page.mouse.move(x, bounds.y + 30); await page.mouse.down();
  await page.mouse.move(x, bounds.y + bounds.height + 4, { steps: 5 });
  const scroll = () => page.locator('.cm-scroller').evaluate(node => node.scrollTop);
  await expect.poll(scroll).toBeGreaterThan(20);
  const first = await scroll(); await page.waitForTimeout(200); const slow = await scroll() - first;
  await page.mouse.move(x, bounds.y + bounds.height + 100);
  const second = await scroll(); await page.waitForTimeout(200); const fast = await scroll() - second;
  expect(fast).toBeGreaterThan(slow);
  await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => [...textRequests]).toContain(200);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(page.locator('.cm-cursor').nth(2)).toBeVisible();
});

test('Text edits update Table and save without alignment whitespace', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Fold multiline', exact: true }).uncheck();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  await editor.click(); await editor.press('ControlOrMeta+Home');
  await editor.press('ArrowDown'); await editor.press('Home');
  await editor.press('Shift+End'); await editor.press('Backspace');
  await editor.pressSequentially('Changed,"line one');
  // The first physical line of the first record; later quoted newlines stay unchanged.
  await expect.poll(async () => (await file.textPage(0, 200)).text).toContain('Changed,"line one\nline two"');
  await page.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Changed');
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect.poll(() => readFile(path, 'utf8')).toContain('Changed,"line one\nline two"');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.setViewportSize({ width: 440, height: 600 });
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-text-aligned.png') });
});

test('Text Alt-drag creates multiple cursors that move, type and delete together', async ({ page }) => {
  await file.dispose(); await writeFile(path, 'name,n\nalpha,10\nbravo,20\ncharl,30\n');
  file = new CsvFile(path, data => { metadata = data; }); await file.open();
  await page.evaluate(data => window.postMessage({ type: 'metadata', data }, '*'), metadata);
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  const point = (line: number) => page.locator('.cm-line').nth(line).evaluate(node => {
    const text = node.querySelector('.csv-text-column-0')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 1); range.collapse(true);
    const bounds = range.getBoundingClientRect(); return { x: bounds.x, y: bounds.y + bounds.height / 2 };
  });
  for (const aligned of [true, false]) {
    await page.getByRole('checkbox', { name: 'Align', exact: true }).setChecked(aligned);
    const start = await point(1), end = await point(3);
    await page.keyboard.down('Alt');
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect(page.locator('.cm-cursor')).toHaveCount(3);
    await editor.press('ArrowRight'); await editor.press('ArrowLeft');
    await editor.press('ArrowUp'); await editor.press('ArrowDown');
    await editor.pressSequentially('X');
    await expect.poll(async () => (await file.textPage(0, 200)).text).toBe('name,n\naXlpha,10\nbXravo,20\ncXharl,30\n');
    await editor.press('Backspace');
    await expect.poll(async () => (await file.textPage(0, 200)).text).toBe('name,n\nalpha,10\nbravo,20\ncharl,30\n');
    await expect(page.locator('.cm-cursor')).toHaveCount(3);
    await editor.press('Escape'); await expect(page.locator('.cm-cursor')).toHaveCount(1);
  }
});

test('Edit menu history shares document changes and availability with keyboard shortcuts', async ({ page }) => {
  const editMenu = page.getByRole('dialog', { name: 'Edit commands', exact: true });
  const openMenu = () => page.getByRole('button', { name: 'Edit', exact: true }).click();
  await openMenu();
  await expect(editMenu.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(editMenu.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  const cell = page.locator('.cell[data-index="0"][data-col="3"]');
  const original = await cell.innerText();
  await cell.dblclick();
  const input = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await input.fill('12345'); await input.press('Enter');
  await expect(cell).toHaveText('12345');
  await openMenu();
  await editMenu.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cell).toHaveText(original);
  await expect(cell).not.toHaveClass(/modified/);
  await page.locator('.viewport').focus();
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect(cell).toHaveText('12345');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(cell).toHaveText(original);
  await openMenu();
  await expect(editMenu.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await editMenu.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(cell).toHaveText('12345');
  await expect(cell).toHaveClass(/modified/);
});

test('first-use guide can be skipped, replayed and completed from Help in both themes', async ({ page }) => {
  await page.evaluate(() => window.postMessage({ type: 'guide', seen: false }, '*'));
  const guide = page.locator('.quick-guide');
  await expect(guide).toBeVisible(); await expect(guide.locator('.guide-progress')).toHaveText('1 / 7');
  await expect(guide.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await guide.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(guide).not.toBeVisible();
  await expect(page.locator('.guide-reminder')).toContainText('top right');
  await page.locator('.guide-reminder').getByRole('button', { name: 'Got it', exact: true }).click();
  await page.evaluate(() => window.postMessage({ type: 'guide', seen: true }, '*'));
  await expect(guide).not.toBeVisible();
  await page.getByRole('button', { name: 'Help: Quick guide', exact: true }).click();
  await expect(page.locator('.guide-reminder')).not.toBeVisible();
  await guide.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(guide).toContainText('Find your data');
  await expect(page.locator('.column-menu')).toHaveAttribute('aria-label', 'Column filter');
  await expect(page.locator('.column-menu input[aria-label="Filter column by text"]')).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-guide-filter.png') });
  await guide.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.column-menu')).toHaveCount(1);
  await expect(page.locator('.column-menu')).toHaveAttribute('aria-label', 'Column options');
  await expect(page.locator('.column-menu button').first()).toHaveText('Pin to left');
  await guide.getByRole('button', { name: 'Back', exact: true }).click();
  await guide.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(guide).toContainText('Browse and edit');
  await expect(page.locator('.column-menu')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-guide-dark.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Help: Quick guide', exact: true })).toBeFocused();
  await page.getByRole('button', { name: /Switch to light/ }).click();
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole('button', { name: 'Help: Quick guide', exact: true }).click();
  for (let step = 0; step < 7; step++) {
    const panel = await guide.locator('.guide-panel').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.y).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(360);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(600);
    if (step === 1) await page.screenshot({ path: join(tmpdir(), 'vscode-csv-guide-filter-narrow.png') });
    if (step === 5) {
      await expect(guide).toContainText('Tips while you work');
      await expect(page.locator('.toolbar-hint')).toContainText('Tips:');
      const hint = (await page.locator('.toolbar-hint').boundingBox())!;
      const spotlight = (await guide.locator('.guide-spotlight').boundingBox())!;
      expect(hint.width).toBeGreaterThan(100);
      expect(spotlight.x).toBeLessThanOrEqual(hint.x);
      expect(spotlight.x + spotlight.width).toBeGreaterThanOrEqual(hint.x + hint.width);
    }
    if (step < 6) await guide.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await expect(guide.locator('.guide-progress')).toHaveText('7 / 7');
  const sample = guide.getByRole('table', { name: 'Color example', exact: true });
  await expect(sample.getByRole('row')).toHaveCount(4);
  await guide.getByRole('button', { name: 'Run example', exact: true }).click();
  await expect(sample.getByRole('row')).toHaveCount(3);
  await expect(sample.locator('.modified')).toHaveText('30');
  await expect(sample.locator('.column-filter-button')).toHaveCSS('background-color', await sample.locator('.column-sort-button').evaluate(node => getComputedStyle(node).backgroundColor));

  expect(await guide.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-guide-light-narrow.png') });
  await guide.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(guide).not.toBeVisible();
  expect(changes).toBe(0);
});

test('guide keeps its target and position when the shaded area is clicked or focus changes', async ({ page }) => {
  const guide = page.locator('.quick-guide');
  for (const size of [{ width: 1000, height: 650 }, { width: 360, height: 600 }]) {
    await page.setViewportSize(size);
    await page.getByRole('button', { name: 'Help: Quick guide', exact: true }).click();
    for (let step = 0; step < 7; step++) {
      await expect(guide.locator('.guide-panel')).not.toHaveAttribute('aria-busy', 'true');
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const panel = await guide.locator('.guide-panel').boundingBox();
      const spotlight = await guide.locator('.guide-spotlight').boundingBox();
      await page.mouse.click(size.width - 12, size.height - 40);
      await page.keyboard.press('Tab');
      // The tracking animation reads its target on the next frame; cross-frame checks catch jumps after a menu closes.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(guide).toBeVisible();
      expect(await guide.locator('.guide-panel').boundingBox()).toEqual(panel);
      expect(await guide.locator('.guide-spotlight').boundingBox()).toEqual(spotlight);
      if (step === 1 || step === 2) await expect(page.locator('.column-menu')).toBeVisible();
      if (step === 4) await expect(page.locator('.command-menu').first()).toBeVisible();
      if (step === 5) {
      await expect(guide).toContainText('Tips while you work');
      await expect(page.locator('.toolbar-hint')).toContainText('Tips:');
      const hint = (await page.locator('.toolbar-hint').boundingBox())!;
      const spotlight = (await guide.locator('.guide-spotlight').boundingBox())!;
      expect(hint.width).toBeGreaterThan(100);
      expect(spotlight.x).toBeLessThanOrEqual(hint.x);
      expect(spotlight.x + spotlight.width).toBeGreaterThanOrEqual(hint.x + hint.width);
    }
    if (step < 6) await guide.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await guide.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.command-menu').first()).not.toBeVisible();
    await expect(page.locator('.column-menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help: Quick guide', exact: true })).toBeFocused();
  }
});

test('guide restores the table position and preserves Text drafts', async ({ page }) => {
  await page.locator('.viewport').evaluate(node => { node.scrollTop = 500; node.scrollLeft = 200; });
  const scroll = await page.locator('.viewport').evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop }));
  const original = await file.textPage(0, 200);
  const help = page.getByRole('button', { name: 'Help: Quick guide', exact: true });
  const guide = page.locator('.quick-guide');
  await help.click();
  await guide.getByRole('button', { name: 'Next', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.column-menu')).toHaveCount(0);
  await expect.poll(() => page.locator('.viewport').evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop }))).toEqual(scroll);
  await expect(help).toBeFocused();
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  await editor.click(); await editor.press('ControlOrMeta+Home'); await editor.pressSequentially('"');
  const draft = await editor.innerText();
  await help.click();
  await expect(guide).toContainText('Browse and edit');
  await expect(page.locator('.viewport')).toBeVisible();
  for (let step = 0; step < 3; step++) await guide.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(guide).toContainText('Block editing in Text');
  await expect(editor).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => editor.innerText()).toBe(draft);
  expect((await file.textPage(0, 200)).text).toBe(original.text);
});

test('aligned Text rectangle follows visible columns across fields of different lengths', async ({ page }) => {
  await file.dispose(); await writeFile(path, 'name,n\nalpha,10\nb,20\ncharl,30\n');
  file = new CsvFile(path, data => { metadata = data; }); await file.open();
  await page.evaluate(data => window.postMessage({ type: 'metadata', data }, '*'), metadata);
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const point = (line: number) => page.locator('.cm-line').nth(line).evaluate(node => {
    const text = node.querySelector('.csv-text-column-1')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.collapse(true);
    const box = range.getBoundingClientRect(); return { x: box.x, y: box.y + box.height / 2 };
  });
  const start = await point(1), end = await point(3);
  await page.keyboard.down('Alt'); await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await page.getByRole('textbox', { name: 'CSV source' }).pressSequentially('9');
  await expect.poll(async () => (await file.textPage(0, 200)).text).toBe('name,n\nalpha,910\nb,920\ncharl,930\n');
});

test('aligned Text block keeps offscreen cursors in the same visible column while scrolling', async ({ page }) => {
  await file.dispose();
  const names = Array.from({ length: 50 }, (_, index) => `row${String(index).padStart(3, '0')}${'x'.repeat(index % 8)}`);
  await writeFile(path, 'name,n\n' + names.map((name, index) => `${name},${index}`).join('\n') + '\n');
  file = new CsvFile(path, data => { metadata = data; }); await file.open();
  await page.evaluate(data => window.postMessage({ type: 'metadata', data }, '*'), metadata);
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const point = (name: string) => page.locator('.cm-line').filter({ hasText: name }).evaluate(node => {
    const text = node.querySelector('.csv-text-column-1')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.collapse(true);
    const box = range.getBoundingClientRect(); return { x: box.x, y: box.y + box.height / 2 };
  });
  const start = await point(names[0]);
  await page.keyboard.down('Alt'); await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = 600; });
  await expect(page.locator('.cm-line').filter({ hasText: names[34] })).toBeVisible();
  const end = await point(names[34]);
  await page.mouse.move(end.x, end.y, { steps: 3 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await page.getByRole('textbox', { name: 'CSV source' }).pressSequentially('9');
  await expect.poll(async () => (await file.textPage(0, 200)).text).toBe('name,n\n' + names.map((name, index) => `${name},${index <= 34 ? '9' : ''}${index}`).join('\n') + '\n');
});

test('aligned Text cursor remains visible when moving right through delimiter padding', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  await editor.click(); await editor.press('ControlOrMeta+Home');
  for (let step = 0; step < 20; step++) {
    await editor.press('ArrowRight');
    await expect.poll(() => page.locator('.cm-cursor').first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(8);
  }
  for (let step = 0; step < 20; step++) {
    await editor.press('ArrowLeft');
    await expect.poll(() => page.locator('.cm-cursor').first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(8);
  }
});

test('native save prompt offers discard while Cancel keeps unsaved changes', async ({ page }) => {
  const original = await readFile(path, 'utf8');
  await page.locator('[data-index="0"][data-col="0"]').dblclick();
  await page.getByRole('textbox', { name: 'Cell value' }).fill('Unsaved');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).press('Enter');
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Unsaved');
  const open = () => page.evaluate(() => window.postMessage({ type: 'savePrompt', saveAs: false, allowDiscard: true }, '*'));
  await open();
  const dialog = page.getByRole('dialog', { name: 'Save CSV' });
  await expect(dialog.getByRole('button', { name: 'Don’t save', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(changes).toBe(1); expect(await readFile(path, 'utf8')).toBe(original);
  await open();
  await dialog.getByRole('button', { name: 'Don’t save', exact: true }).click();
  await expect.poll(() => changes).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(original);
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect(dialog).toBeHidden();
});

test('native save prompt allows discarding an unfinished Text draft', async ({ page }) => {
  const original = await readFile(path, 'utf8');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  await editor.click(); await editor.press('ControlOrMeta+Home'); await editor.pressSequentially('"');
  await expect(page.locator('.text-error')).toBeVisible();
  await page.evaluate(() => window.postMessage({ type: 'savePrompt', saveAs: false, allowDiscard: true }, '*'));
  const dialog = page.getByRole('dialog', { name: 'Save CSV' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Don’t save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await readFile(path, 'utf8')).toBe(original);
});

test('all block-edit cursors remain visible when moving across aligned delimiters', async ({ page }) => {
  await file.dispose(); await writeFile(path, 'name,n\nalpha,10\nb,20\ncharl,30\n');
  file = new CsvFile(path, data => { metadata = data; }); await file.open();
  await page.evaluate(data => window.postMessage({ type: 'metadata', data }, '*'), metadata);
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const first = await page.locator('.cm-line').nth(1).boundingBox();
  const last = await page.locator('.cm-line').nth(3).boundingBox();
  const x = first!.x + 6;
  await page.keyboard.down('Alt'); await page.mouse.move(x, first!.y + 10); await page.mouse.down();
  await page.mouse.move(x, last!.y + 10, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(page.locator('.cm-cursor')).toHaveCount(3);
  for (const key of ['ArrowRight', 'ArrowLeft']) for (let step = 0; step < 9; step++) {
    await page.getByRole('textbox', { name: 'CSV source' }).press(key);
    await expect.poll(() => page.locator('.cm-cursor').evaluateAll(nodes => Math.min(...nodes.map(node => node.getBoundingClientRect().height)))).toBeGreaterThan(8);
    await expect(page.locator('.cm-cursor')).toHaveCount(3);
    for (const cursor of await page.locator('.cm-cursor').all()) await expect(cursor).toHaveCSS('border-left-width', '2px');
  }
});


test('Text cursor stays thick and legible in dark and light themes', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'CSV source' });
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: /Switch to light/ }).click();
    await editor.click(); await editor.press('ControlOrMeta+Home'); await editor.press('ArrowRight');
    const cursor = page.locator('.cm-cursor').first();
    await expect(cursor).toHaveCSS('border-left-width', '2px');
    const colors = await cursor.evaluate(node => ({ cursor: getComputedStyle(node).borderLeftColor, background: getComputedStyle(document.querySelector('.cm-editor')!).backgroundColor }));
    expect(colors.cursor).not.toBe(colors.background);
    await page.screenshot({ animations: 'disabled', path: join(tmpdir(), `vscode-csv-cursor-${theme}.png`) });
  }
});

async function dataCommand(page: Page, menu: 'View' | 'Edit' | 'Data', name: RegExp): Promise<void> {
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('dialog', { name: `${menu} commands`, exact: true }).getByRole('button', { name }).click();
}

test('entire-file search reaches unloaded rows and replacement keeps disk unchanged until save', async ({ page }) => {
  await dataCommand(page, 'Edit', /Search or replace throughout/);
  const dialog = page.getByRole('dialog', { name: 'Find and replace', exact: true });
  await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Product 001');
  await dialog.getByRole('button', { name: 'Find all', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('1 matching cells');
  await dialog.getByRole('button', { name: /Product #600/ }).click();
  await expect(page.locator('[data-index="599"][data-col="0"]')).toHaveText('Product 001');
  await dataCommand(page, 'Edit', /Search or replace throughout/);
  await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Product 001');
  await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('Updated final product');
  await dialog.getByRole('button', { name: 'Replace matches', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Replacement applied');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('[data-index="599"][data-col="0"]')).toHaveText('Updated final product');
  expect(await readFile(path, 'utf8')).not.toContain('Updated final product');
  expect((await file.page(599, 1)).rows[0].values[0]).toBe('Updated final product');
});

test('one find and replace panel switches between entire file and selection and disables missing selections', async ({ page }) => {
  await dataCommand(page, 'Edit', /Search or replace throughout/);
  const dialog = page.getByRole('dialog', { name: 'Find and replace', exact: true });
  const scope = dialog.getByRole('combobox', { name: 'Search scope', exact: true });
  await expect(scope).toHaveValue('all');
  await expect.poll(() => scope.locator('option[value="selection"]').evaluate(node => (node as HTMLOptionElement).disabled)).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  await expectColumnStart(page, 0, ['Product 001', 'Product 002']);
  await selectRectangle(page, 0, 0, 1, 0);
  await page.locator('.cell.selected[role="gridcell"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Find and replace…', exact: true }).click();
  await expect(scope).toHaveValue('selection');
  await expect.poll(() => scope.locator('option[value="selection"]').evaluate(node => (node as HTMLOptionElement).disabled)).toBe(false);
  await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Product');
  await dialog.getByRole('button', { name: 'Find all', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('2 matching cells');
  await scope.selectOption('all');
  await dialog.getByRole('button', { name: 'Find all', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('600 matching cells');
  await scope.selectOption('selection');
  await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('Selected');
  await dialog.getByRole('button', { name: 'Replace matches', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Replacement applied');
  expect((await file.textPage(599, 2)).text).toContain('Selected 002');
  expect((await file.textPage(599, 2)).text).toContain('Selected 001');
  expect((await file.textPage(1, 1)).text).toContain('Product 600');
  expect(await readFile(path, 'utf8')).not.toContain('Selected');
});

test('rectangular paste after sorting writes original rows and selected fill follows the current view', async ({ page }) => {
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  await expectColumnStart(page, 0, ['Product 001', 'Product 002']);
  await selectRectangle(page, 0, 0, 0, 0);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'A\tFirst note\nB\tSecond note');
    document.querySelector('.viewport')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expectColumnStart(page, 0, ['A', 'B']);
  expect((await file.textPage(599, 2)).text).toMatch(/B,Second note[\s\S]*A,First note/);
  expect(await readFile(path, 'utf8')).toContain('Product 001');
  await selectRectangle(page, 0, 1, 1, 1);
  await page.locator('.cell.selected[role="gridcell"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fill selection…', exact: true }).click();
  const fill = page.getByRole('dialog', { name: 'Fill selected cells', exact: true });
  await fill.getByRole('textbox', { name: 'Value', exact: true }).fill('shared value');
  await fill.getByRole('button', { name: 'Fill cells', exact: true }).click();
  await expectColumnStart(page, 1, ['shared value', 'shared value']);
});

test('insert and delete rows and columns update the working document without overwriting the source', async ({ page }) => {
  await page.locator('.row-number[data-index="0"]').click({ button: 'right', position: { x: 45, y: 15 } });
  await page.getByRole('menuitem', { name: 'Insert rows above…', exact: true }).click();
  const rows = page.getByRole('dialog', { name: 'Insert rows', exact: true });
  await rows.getByRole('spinbutton', { name: 'Before original row', exact: true }).fill('1');
  await rows.getByRole('spinbutton', { name: 'Number of rows', exact: true }).fill('2');
  await rows.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '602');
  await expectColumnStart(page, 0, ['', '', 'Product 600']);
  for (const index of [0, 1]) expect(await page.locator(`.cell[data-index="${index}"][data-col]`).evaluateAll(cells => cells.length > 0 && cells.every(cell => cell.classList.contains('modified')))).toBe(true);
  await expect(page.locator('.cell[data-index="2"][data-col].modified')).toHaveCount(0);
  await page.locator('.column-heading[data-col="0"] .column-label').click({ button: 'right' });
  await page.getByRole('button', { name: 'Insert column after…', exact: true }).click();
  const column = page.getByRole('dialog', { name: 'Insert column', exact: true });
  await expect(column.getByRole('combobox', { name: 'Column', exact: true })).toHaveValue('1');
  await column.getByRole('combobox', { name: 'Column', exact: true }).selectOption('7');
  await column.getByRole('textbox', { name: 'Column name', exact: true }).fill('Added');
  await column.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(column).toBeHidden();
  expect((await file.page(0, 1)).rows[0].values).toHaveLength(8);
  await page.locator('.viewport').evaluate(node => { node.scrollLeft = 9999; });
  await expect.poll(() => page.locator('.cell[data-col="7"]').evaluateAll(cells => cells.length > 0 && cells.every(cell => cell.classList.contains('modified')))).toBe(true);
  await page.locator('.viewport').evaluate(node => { node.scrollLeft = 0; });
  await page.locator('.row-number[data-index="0"]').click();
  await page.locator('.row-number[data-index="0"]').click({ button: 'right', position: { x: 45, y: 15 } });
  await page.getByRole('menuitem', { name: 'Delete selected rows…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete selected rows', exact: true }).getByRole('button', { name: 'Delete rows', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '601');
  await page.locator('.column-heading[data-col="0"] .column-label').click();
  await page.locator('.column-heading[data-col="0"] .column-label').click({ button: 'right' });
  await page.getByRole('button', { name: 'Delete selected columns…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete selected columns', exact: true }).getByRole('button', { name: 'Delete columns', exact: true }).click();
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('Note');
  expect((await file.page(0, 1)).rows[0].values).toHaveLength(7);
  expect((await readFile(path, 'utf8')).startsWith('Product,Note,Link')).toBe(true);
  const undo = page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true });
  for (let index = 0; index < 4; index++) {
    const before = file.changes; await undo.click();
    await expect.poll(() => file.changes).not.toBe(before);
  }
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '600');
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('Product');
  await expect(page.locator('.cell.modified')).toHaveCount(0);
  expect(file.changes).toBe(0);
  const redo = page.getByRole('button', { name: 'Redo (Ctrl/Cmd+Shift+Z)', exact: true });
  for (let index = 0; index < 4; index++) {
    const before = file.changes; await redo.click();
    await expect.poll(() => file.changes).not.toBe(before);
  }
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '601');
  await expect.poll(() => page.locator('.cell[data-index="0"][data-col]').evaluateAll(cells => cells.length > 0 && cells.every(cell => cell.classList.contains('modified')))).toBe(true);
});

test('column visibility, jump and check results stay usable in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 650 });
  await dataCommand(page, 'View', /Click: search, hide, or show columns/);
  const columns = page.getByRole('dialog', { name: 'Show and hide columns', exact: true });
  await columns.getByRole('textbox', { name: 'Search columns', exact: true }).fill('Product');
  await columns.getByRole('checkbox', { name: '1 · Product', exact: true }).uncheck();
  await columns.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.column-heading[data-col="0"]')).toHaveCount(0);
  await dataCommand(page, 'View', /Click: jump to an original row/);
  const jump = page.getByRole('dialog', { name: 'Go to original row', exact: true });
  await jump.getByRole('spinbutton', { name: 'Original row number', exact: true }).fill('600');
  await jump.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.locator('.row-number[data-index="599"]')).toBeVisible();
  await dataCommand(page, 'Data', /Find duplicate values, empty cells/);
  const check = page.getByRole('region', { name: 'Data check results', exact: true });
  await check.getByRole('combobox', { name: 'Check', exact: true }).selectOption('missing');
  await check.getByRole('combobox', { name: 'Column', exact: true }).selectOption('4');
  await check.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(check.getByRole('status')).toContainText('2 issues');
  await check.getByRole('button', { name: /Row #3 · Region/ }).click();
  await expect(page.locator('[data-index="2"][data-col="4"]')).toBeVisible();
  expect(await page.locator('.toolbar').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('file format reports incompatible parsing, recovers with the right delimiter and refuses dirty changes', async ({ page }) => {
  await dataCommand(page, 'Data', /Reopen with a different encoding or delimiter/);
  const format = page.getByRole('dialog', { name: 'File format', exact: true });
  await format.getByRole('combobox', { name: 'Delimiter', exact: true }).selectOption(';');
  await format.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(format.getByRole('alert')).toContainText('Invalid Opening Quote');
  await format.getByRole('combobox', { name: 'Delimiter', exact: true }).selectOption(',');
  await format.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(format).toBeHidden();
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 600');
  await selectRectangle(page, 0, 0, 0, 0);
  await page.locator('.cell.selected[role="gridcell"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fill selection…', exact: true }).click();
  const fill = page.getByRole('dialog', { name: 'Fill selected cells', exact: true });
  await fill.getByRole('textbox', { name: 'Value', exact: true }).fill('Changed');
  await fill.getByRole('button', { name: 'Fill cells', exact: true }).click();
  await dataCommand(page, 'Data', /Reopen with a different encoding or delimiter/);
  await format.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(format.getByRole('alert')).toContainText('Save or discard changes');
  expect(await readFile(path, 'utf8')).toContain('Product 600');
});

test('automatic statistics stop above 1000 cells even when the selected data is cached', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 6100 });
  await selectRectangle(page, 0, 0, 199, 4);
  await expect(page.locator('.status')).toContainText('200 rows × 5 columns');
  await expect(page.locator('.status')).toContainText('Numbers 202');
  await expect(page.getByRole('button', { name: 'Calculate selection', exact: true })).toBeHidden();
  const before = statsRequests;
  await selectRectangle(page, 0, 0, 200, 4);
  await expect(page.locator('.status')).toContainText('201 rows × 5 columns');
  await page.waitForTimeout(350);
  expect(statsRequests).toBe(before);
  await expect(page.getByRole('button', { name: 'Calculate selection', exact: true })).toBeVisible();
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Numbers 203');
  await expect(page.getByRole('button', { name: 'Calculate selection', exact: true })).toBeVisible();
});

test('large text selections remain manual even with a few loaded cells', async ({ page }) => {
  for (let row = 0; row < 3; row++) await file.edit({ row, col: 1, value: 'x'.repeat(100000) });
  await page.evaluate(() => window.postMessage({ type: 'changed', changes: 3 }, '*'));
  await expect(page.locator('[data-index="0"][data-col="1"]')).toHaveText(/^x+$/);
  const first = (await page.locator('.row-number[data-index="0"]').boundingBox())!;
  const last = (await page.locator('.row-number[data-index="2"]').boundingBox())!;
  await page.mouse.move(first.x + first.width - 20, first.y + 10); await page.mouse.down();
  await page.mouse.move(last.x + last.width - 20, last.y + 10, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('.status')).toContainText('3 rows × 7 columns');
  await page.waitForTimeout(350);
  expect(statsRequests).toBe(0);
  await expect(page.getByRole('button', { name: 'Calculate selection', exact: true })).toBeVisible();
  await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Non-empty 20');
});

test('Text remains editable after a full-file replacement refreshes its revision', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await dataCommand(page, 'Edit', /Search or replace throughout/);
  const dialog = page.getByRole('dialog', { name: 'Find and replace', exact: true });
  await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('Product 600');
  await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('Updated text');
  await dialog.getByRole('button', { name: 'Replace matches', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Replacement applied');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Updated text');
  await page.locator('.cm-content').click(); await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('X');
  await page.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('XProduct');
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Updated text');
});

test('complex sample aligns every delimiter and multiline continuation while preserving mixed newline bytes', async ({ page }) => {
  await SampleCsv.create(path, 'small');
  const original = await readFile(path, 'utf8');
  await file.reload(); await file.search({ text: 'Mechanical', limit: 1 });
  await page.evaluate(data => { window.postMessage({ type: 'metadata', data }, '*'); window.postMessage({ type: 'viewReset' }, '*'); }, metadata);
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('ID');
  await expect(page.locator('.cell[data-index="0"][data-col="0"]')).toHaveText('1');
  await page.locator('.viewport').evaluate(node => { node.scrollLeft = 1620; });
  await expect(page.locator('.cell[data-index="0"][data-col="9"] a')).toHaveCount(2);
  await expect(page.locator('.cell[data-index="0"][data-col="10"] a')).toHaveAttribute('href', 'https://example.com/docs/product-care');
  const multilineLinks = page.locator('.cell[data-index="2"][data-col="10"] a');
  await expect(multilineLinks).toHaveCount(2);
  await expect(multilineLinks.nth(0)).toHaveAttribute('href', 'https://example.org/guides/setup');
  await expect(multilineLinks.nth(1)).toHaveAttribute('href', 'https://example.net/help#returns');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Fold multiline', exact: true }).uncheck();
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('Second line contains');
  const alignment = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-line')];
    const rows = lines.map(line => [...line.querySelectorAll('.csv-text-delimiter')].map(node => node.getBoundingClientRect().x)).filter(row => row.length === 19);
    const positions = rows[0].map((_, column) => rows.map(row => row[column]));
    for (const line of lines) {
      const commas = [...line.querySelectorAll('.csv-text-delimiter')].map(node => node.getBoundingClientRect().x);
      const first = commas.length === 9 ? 10 : 0;
      commas.forEach((x, index) => positions[first + index]?.push(x));
    }
    const x = (prefix: string) => {
      const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.startsWith(prefix)) {
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1); return range.getBoundingClientRect().x;
      }
      throw new Error(`Missing text: ${prefix}`);
    };
    return { records: rows.length, errors: positions.map(values => Math.max(...values) - Math.min(...values)), continuation: x('Second line contains'), description: x('Description') };
  });
  expect(alignment.records).toBeGreaterThanOrEqual(3);
  expect(Math.max(...alignment.errors)).toBeLessThan(1);
  expect(Math.abs(alignment.continuation - alignment.description)).toBeLessThan(1);
  await page.locator('.cm-scroller').evaluate(node => { node.scrollLeft = 1600; });
  await expect.poll(() => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cm-line')].map(line => [...line.querySelectorAll('.csv-text-delimiter')].map(node => node.getBoundingClientRect().x)).filter(row => row.length === 19);
    return Math.max(...Array.from({ length: 19 }, (_, col) => Math.max(...rows.map(row => row[col])) - Math.min(...rows.map(row => row[col]))));
  })).toBeLessThan(1);
  await page.locator('html').evaluate(node => node.style.setProperty('--vscode-editor-font-family', 'Arial, sans-serif'));
  await expect.poll(() => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cm-line')].map(line => [...line.querySelectorAll('.csv-text-delimiter')].map(node => node.getBoundingClientRect().x)).filter(row => row.length === 19);
    return Math.max(...Array.from({ length: 19 }, (_, col) => Math.max(...rows.map(row => row[col])) - Math.min(...rows.map(row => row[col]))));
  })).toBeLessThan(1);

  await editor.click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.type('X');
  await page.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Switch to Text mode', exact: true })).toBeVisible();
  await expect(page.locator('.viewport')).toBeVisible();
  await page.locator('.viewport').evaluate(node => { node.scrollLeft = 0; });
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('XID');
  const output = join(directory, 'mixed-newlines.csv'); await file.save(output);
  expect(await readFile(output, 'utf8')).toBe('X' + original);
  expect(await readFile(path, 'utf8')).toBe(original);
});

test('aligned Text measures Chinese Japanese Korean and emoji by rendered width and preserves original CSV', async ({ page }) => {
  const source = 'Name,Note,Value\r\n中文产品，宽字符,"第一行内容\n第二行：带全角标点！",12\r\n日本語の商品,短いメモ,3\r\n한국어 제품,설명 😀,44\r\nASCII,café 🎧,5\r\n';
  await replaceSource(page, source, '中文产品，宽字符');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Fold multiline', exact: true }).uncheck();
  await expect(page.locator('.cm-content')).toContainText('第二行：带全角标点！');
  const measure = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cm-line')].map(line => [...line.querySelectorAll('.csv-text-delimiter')].map(node => node.getBoundingClientRect().x)).filter(row => row.length === 2);
    const spreads = [0, 1].map(col => Math.max(...rows.map(row => row[col])) - Math.min(...rows.map(row => row[col])));
    const x = (prefix: string) => {
      const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.startsWith(prefix)) {
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1); return range.getBoundingClientRect().x;
      }
      throw new Error('Missing text: ' + prefix);
    };
    return { count: rows.length, spreads, continuation: x('第二行：'), header: x('Note') };
  });
  const aligned = await measure(); expect(aligned.count).toBeGreaterThanOrEqual(4);
  expect(Math.max(...aligned.spreads)).toBeLessThan(1);
  expect(Math.abs(aligned.continuation - aligned.header)).toBeLessThan(1);
  await page.getByRole('checkbox', { name: 'Align', exact: true }).uncheck();
  expect(Math.max(...(await measure()).spreads)).toBeGreaterThan(10);
  await page.getByRole('checkbox', { name: 'Align', exact: true }).check();
  expect(Math.max(...(await measure()).spreads)).toBeLessThan(1);
  expect((await file.textPage(0, 10)).text.replace(/\r\n/g, '\n')).toBe(source.replace(/\r\n/g, '\n'));
  const output = join(directory, 'unicode.csv'); await file.save(output);
  expect(await readFile(output, 'utf8')).toBe(source);
  expect(await readFile(path, 'utf8')).toBe(source);
});

async function changeLanguage(page: Page, target: Language): Promise<void> {
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
  await page.getByRole('dialog', { name: /^(Settings commands|设置命令)$/ }).getByRole('button', { name: /^(Language|语言)/ }).click();
  await page.getByRole('menuitemradio', { name: target === 'en' ? 'English' : '简体中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', target);
}

async function checkPanel(page: Page, kind = 'missing', column = '4') {
  await dataCommand(page, 'Data', /Find duplicate values, empty cells/);
  const panel = page.getByRole('region', { name: 'Data check results', exact: true });
  await panel.getByRole('combobox', { name: 'Check', exact: true }).selectOption(kind);
  if (kind !== 'ragged') await panel.getByRole('combobox', { name: 'Column', exact: true }).selectOption(column);
  await panel.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Run check', exact: true })).toBeEnabled();
  return panel;
}

test('check results stay open during navigation and select exact original cells after sorting', async ({ page }) => {
  const sort = page.getByRole('button', { name: 'Sort Amount', exact: true });
  await sort.dblclick(); await expectColumnStart(page, 3, ['0', '1']);
  await sort.dblclick(); await expectColumnStart(page, 3, ['599', '598']);
  const panel = await checkPanel(page);
  await expect(panel.getByRole('status')).toContainText('2 issues');
  await panel.getByRole('checkbox', { name: 'Select listed issue 1', exact: true }).check();
  await panel.getByRole('button', { name: /Row #3 · Region/ }).click();
  await expect(panel).toBeVisible();
  await expect(page.locator('.row-number[data-index="597"]')).toHaveText('3');
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.row-number[data-index="596"]')).toHaveText('4');
  await panel.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'Select listed issue 1', exact: true })).toBeChecked();
  await panel.getByRole('checkbox', { name: 'Select listed issue 2', exact: true }).check();
  await panel.getByRole('button', { name: 'Select checked cells', exact: true }).click();
  await expect(page.locator('.status')).toContainText('2 rows × 1 columns');
  await expect(page.locator('[role="gridcell"].selected')).toHaveCount(2);
  await expect(page.locator('[role="gridcell"].selected:not([data-col="4"])')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close check results', exact: true }).click();
  await dataCommand(page, 'Data', /Find duplicate values, empty cells/);
  await expect(panel.getByRole('status')).toContainText('2 checked');
  await panel.getByRole('button', { name: /Row #3 · Region/ }).click();
  const region = page.locator('[data-index="597"][data-col="4"]');
  await region.dblclick();
  const edit = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await edit.fill('Europe');
  await edit.press('Enter');
  await expect(panel.getByRole('alert')).toContainText('Data changed');
  await expect(panel.getByRole('button', { name: 'Select checked cells', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /Row #3 · Region/ })).toBeDisabled();
  await panel.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('1 issues');
  await expect(panel.getByRole('status')).toContainText('0 checked');
  expect((await file.page(597, 1)).rows[0]?.values[4]).toBe('Europe');
  expect(await readFile(path, 'utf8')).not.toContain('Europe');
});

test('checked rows excluded by filters preserve the current selection and results remain available', async ({ page }) => {
  await numberFilter(page, 'Region', 'gte', '5');
  await page.locator('.row-number[data-index="0"]').click();
  await expect(page.locator('.status')).toContainText('1 rows × 7 columns');
  const panel = await checkPanel(page);
  await panel.getByRole('checkbox', { name: 'Select all listed results', exact: true }).check();
  await panel.getByRole('button', { name: 'Select checked cells', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('excluded');
  await expect(page.locator('.status')).toContainText('1 rows × 7 columns');
  await expect(page.locator('.row-number.axis-selected')).toHaveText(['1']);
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('excluded');
  await expect(panel.getByRole('status')).toContainText('2 checked');
  await expect(page.locator('.row-number.axis-selected')).toHaveText(['1']);
});

test('selecting all check results selects only the listed cells of a truncated scan', async ({ page }) => {
  const panel = await checkPanel(page, 'duplicates', '1');
  await expect(panel.getByRole('status')).toContainText('599 issues');
  await expect(panel.getByRole('status')).toContainText('Showing 1–200');
  await panel.getByRole('checkbox', { name: 'Select all listed results', exact: true }).check();
  await panel.getByRole('button', { name: 'Select checked cells', exact: true }).click();
  await expect(page.locator('.status')).toContainText('200 rows × 1 columns');
  await expect(panel.getByRole('status')).toContainText('200 checked');
  expect(await readFile(path, 'utf8')).toContain('Product 600');
});

test('check navigation loads later batches and returns across a batch boundary without losing the total', async ({ page }) => {
  const panel = await checkPanel(page, 'duplicates', '1');
  await expect(panel.getByRole('status')).toContainText('599 issues');
  await panel.getByRole('button', { name: /^Row #201 · Note/ }).click();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.getByRole('button', { name: /^Row #202 · Note/ })).toHaveAttribute('aria-current', 'true');
  await expect(panel.getByRole('status')).toContainText('599 issues');
  await expect(page.locator('.row-number[data-index="201"]')).toHaveText('202');
  await panel.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(panel.getByRole('button', { name: /^Row #201 · Note/ })).toHaveAttribute('aria-current', 'true');
  await expect(panel.getByRole('status')).toContainText('599 issues');
});

test('checking cell issues selects exact cells immediately and sparse clearing preserves unrelated values', async ({ page }) => {
  await replaceSource(page, 'ID,A,B\nid1,,\nid2,,\nid3,ready,ready\n', 'id1');
  const panel = await checkPanel(page, 'missing', 'all');
  await expect(panel.getByRole('status')).toContainText('4 issues');
  await panel.getByRole('checkbox', { name: 'Select all listed results', exact: true }).check();
  await expect(page.locator('.status')).toContainText('2 rows × 2 columns');
  await expect(page.locator('[role="gridcell"].selected')).toHaveCount(4);
  await panel.getByRole('checkbox', { name: 'Select listed issue 2', exact: true }).uncheck();
  await expect(page.locator('[role="gridcell"].selected')).toHaveCount(3);
  await panel.getByRole('checkbox', { name: 'Select listed issue 3', exact: true }).uncheck();
  await expect(page.locator('[role="gridcell"].selected')).toHaveCount(2);
  await expect(page.locator('[role="gridcell"].selected[data-col="0"]')).toHaveCount(0);
  // Filling a sparse selection must not modify the other cells in its bounding rectangle.
  await page.locator('[data-index="0"][data-col="1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Fill/ }).click();
  const fill = page.getByRole('dialog', { name: 'Fill selected cells', exact: true });
  await fill.getByRole('textbox').fill('fixed');
  await fill.getByRole('button', { name: 'Fill cells', exact: true }).click();
  await expect.poll(async () => (await file.page(0, 3)).rows.map(row => row.values)).toEqual([['id1', 'fixed', ''], ['id2', '', 'fixed'], ['id3', 'ready', 'ready']]);

});

test('native table Copy and Cut preserve full TSV values in sorted reordered visible columns and Undo restores cells', async ({ page }) => {
  const long = 'A'.repeat(5000) + '\t"tail"';
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const original = `A,B,C,D\nfirst,first note,1,keep1\nsecond,"line one\nline two",3,keep2\n${quote(long)},third note,2,keep3\n`;
  await replaceSource(page, original, 'first');
  const sort = page.getByRole('button', { name: 'Sort C', exact: true });
  await sort.dblclick(); await expectColumnStart(page, 2, ['1', '2']);
  await sort.dblclick(); await expectColumnStart(page, 2, ['3', '2']);
  await dataCommand(page, 'View', /Click: search, hide, or show columns/);
  const visibility = page.getByRole('dialog', { name: 'Show and hide columns', exact: true });
  await visibility.getByRole('checkbox', { name: '4 · D', exact: true }).uncheck();
  await visibility.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    document.querySelector('.column-heading[data-col="1"] .column-drag-handle')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    const target = document.querySelector('.column-heading[data-col="0"]')!;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: rect.left + 2, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('B');
  await sort.dblclick(); await sort.dblclick();
  await dataCommand(page, 'View', /Click: search, hide, or show columns/);
  await visibility.getByRole('checkbox', { name: '4 · D', exact: true }).uncheck();
  await visibility.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.column-heading[data-col]')).toHaveCount(3);
  await selectRectangle(page, 0, 0, 1, 2);
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboardText).not.toBe('');
  expect(parse(clipboardText, { delimiter: '\t' })).toEqual([['line one\nline two', 'second', '3'], ['third note', long, '2']]);
  await page.locator('[data-index="0"][data-col="1"]').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Cell actions', exact: true });
  await expect(menu).toBeVisible();
  await expect(page.locator('.status')).toContainText('2 rows × 3 columns');
  await menu.getByRole('menuitem', { name: /^Cut/ }).click();
  await expectColumnStart(page, 0, ['first note', '', '']);
  expect(parse(clipboardText, { delimiter: '\t' })).toEqual([['line one\nline two', 'second', '3'], ['third note', long, '2']]);
  const cutRows = (await file.page(0, 3)).rows.map(row => ({ id: row.id, values: row.values }));
  expect(cutRows).toContainEqual({ id: 1, values: ['', '', '', 'keep2'] });
  expect(cutRows).toContainEqual({ id: 2, values: ['', '', '', 'keep3'] });
  expect(await readFile(path, 'utf8')).toBe(original);
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click();
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('first note');
  await expect.poll(async () => (await file.page(2, 1)).rows[0]?.values[1]).toBe(long);
  expect((await file.page(1, 1)).rows[0]?.values[0]).toBe('line one\nline two');
});

test('clipboard failures preserve cut cells and cell menus paste through the host clipboard', async ({ page }) => {
  await selectRectangle(page, 0, 0, 1, 1);
  clipboardFailure = 'Clipboard write denied';
  await page.keyboard.press('ControlOrMeta+x');
  await expect(page.locator('.status')).toContainText('Clipboard write denied');
  await expectColumnStart(page, 0, ['Product 600', 'Product 599']);
  await expect(page.locator('.clipboard-source')).toHaveCount(0);
  expect(file.changes).toBe(0);
  clipboardFailure = undefined; clipboardText = 'Pasted\t"line A\nline B"';
  await page.locator('[data-index="2"][data-col="0"]').click({ button: 'right' });
  await expect(page.locator('.status')).toContainText('1 rows × 1 columns');
  await page.getByRole('menu', { name: 'Cell actions', exact: true }).getByRole('menuitem', { name: /^Paste/ }).click();
  await expect(page.locator('[data-index="2"][data-col="0"]')).toHaveText('Pasted');
  expect((await file.page(2, 1)).rows[0]?.values[1]).toBe('line A\nline B');
  await page.locator('[data-index="2"][data-col="0"]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Cell actions', exact: true }).getByRole('menuitem', { name: 'Clear contents', exact: true }).click();
  await expect(page.locator('[data-index="2"][data-col="0"]')).toHaveText('');
  expect(await readFile(path, 'utf8')).toContain('Product 598');
});

test('copy source stays marked while choosing and pasting targets and cut-paste remains undoable', async ({ page }) => {
  const original = 'A,B\nfirst,"line one\nline two"\nsecond,"quoted ""text"""\nthird,note3\nfourth,note4\n';
  await replaceSource(page, original, 'first');
  await selectRectangle(page, 0, 0, 0, 1);
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.locator('.clipboard-source[data-index="0"]')).toHaveCount(2);
  await selectRectangle(page, 2, 0, 2, 0);
  await expect(page.locator('.clipboard-source[data-index="0"]')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('[data-index="2"][data-col="0"]')).toHaveText('first');
  expect((await file.page(2, 1)).rows[0]?.values[1]).toBe('line one\nline two');
  await expect(page.locator('.clipboard-source[data-index="0"]')).toHaveCount(2);
  await selectRectangle(page, 3, 0, 3, 0); await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('[data-index="3"][data-col="0"]')).toHaveText('first');
  await page.keyboard.press('Escape');
  await expect(page.locator('.clipboard-source')).toHaveCount(0);
  await selectRectangle(page, 1, 0, 1, 1); await page.keyboard.press('ControlOrMeta+x');
  await expect(page.locator('[data-index="1"][data-col="0"]')).toHaveText('');
  await expect(page.locator('.clipboard-source.clipboard-cut')).toHaveCount(2);
  await selectRectangle(page, 2, 0, 2, 0); await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('[data-index="2"][data-col="0"]')).toHaveText('second');
  await expect(page.locator('.clipboard-source')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click();
  await expect.poll(async () => (await file.page(2, 1)).rows[0]?.values[0]).toBe('first');
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click();
  await expect.poll(async () => (await file.page(1, 1)).rows[0]?.values[0]).toBe('second');
  expect(await readFile(path, 'utf8')).toBe(original);
});

test('URL dragging remains cell selection through redraw and double-click permits text selection in the editor', async ({ page }) => {
  const selector = '[data-index="0"][data-col="2"] a';
  await dragText(page, selector, 8, 19, async () => {
    await page.evaluate(data => window.postMessage({ type: 'metadata', data }, '*'), metadata);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  });
  await expect(page.locator('.cell.selected')).toHaveCount(1);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  expect(links).toEqual([]);
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboardText).toBe('https://example.com/0');
  await page.locator(selector).dblclick();
  const editor = page.locator('.inline-cell-input'); await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('https://example.com/0');
  await editor.evaluate(element => { const node = element as HTMLTextAreaElement; node.focus(); node.setSelectionRange(8, 19); });
  expect(await editor.evaluate(element => { const node = element as HTMLTextAreaElement; return node.value.slice(node.selectionStart, node.selectionEnd); })).toBe('example.com');
  clipboardText = 'table clipboard untouched';
  await page.keyboard.press('ControlOrMeta+c');
  expect(clipboardText).toBe('table clipboard untouched');
  expect(links).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  expect(file.changes).toBe(0);
});

test('regular-expression filtering persists its type and rejects invalid patterns without changing the active view', async ({ page }) => {
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Column filter', exact: true });
  const type = menu.getByRole('combobox', { name: 'Filter type', exact: true });
  await expect(type).toHaveValue('text');
  await type.selectOption('regex');
  await menu.getByRole('textbox', { name: 'Filter column by regular expression', exact: true }).fill('^Product 00[12]$');
  await menu.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expectColumnStart(page, 0, ['Product 002', 'Product 001']);
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '2');
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  await expect(type).toHaveValue('regex');
  const input = menu.getByRole('textbox', { name: 'Filter column by regular expression', exact: true });
  await expect(input).toHaveValue('^Product 00[12]$');
  await input.fill('[');
  await menu.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(menu.getByRole('alert')).not.toBeEmpty();
  await expect(menu).toBeVisible(); await expect(input).toHaveValue('[');
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '2');
  expect((await file.page(0, 2)).rows.map(row => row.values[0])).toEqual(['Product 002', 'Product 001']);
  await menu.getByRole('button', { name: 'Reset column filter', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '600');
  expect(file.changes).toBe(0);
});

test('value filters enumerate unloaded records and preserve exact selected values across reopening and language changes', async ({ page }) => {
  const values = ['001', '1', 'Alpha', 'alpha', '', ...Array.from({ length: 595 }, () => 'common'), 'Tail only'];
  await replaceSource(page, 'A,B\n' + values.map((value, index) => `${value},${index}`).join('\n') + '\n', '001');
  await page.getByRole('button', { name: 'Filter A', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Column filter', exact: true });
  await menu.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('values');
  await expect(menu.getByRole('checkbox', { name: 'Tail only', exact: true })).toBeVisible();
  await menu.getByRole('button', { name: 'Clear selected values', exact: true }).click();
  const search = menu.getByRole('textbox', { name: 'Search values', exact: true });
  await search.fill('tail');
  await menu.getByRole('checkbox', { name: 'Tail only', exact: true }).check();
  await search.fill('');
  for (const value of ['001', 'alpha', '(Empty)']) await menu.getByRole('checkbox', { name: value, exact: true }).check();
  await menu.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '4');
  expect((await file.page(0, 10)).rows.map(row => row.values[0])).toEqual(['001', 'alpha', '', 'Tail only']);
  await page.getByRole('button', { name: 'Filter A', exact: true }).click();
  await expect(menu.getByRole('combobox', { name: 'Filter type', exact: true })).toHaveValue('values');
  for (const value of ['001', 'alpha', '(Empty)', 'Tail only']) await expect(menu.getByRole('checkbox', { name: value, exact: true })).toBeChecked();
  for (const value of ['1', 'Alpha']) await expect(menu.getByRole('checkbox', { name: value, exact: true })).not.toBeChecked();
  await page.keyboard.press('Escape'); await changeLanguage(page, 'zh-CN');
  await page.getByRole('button', { name: '筛选 A', exact: true }).click();
  const translated = page.locator('.column-menu');
  await expect(translated.locator('select').first()).toHaveValue('values');
  await expect(translated.getByRole('checkbox', { name: '001', exact: true })).toBeChecked();
  await expect(translated.getByRole('checkbox', { name: 'Alpha', exact: true })).not.toBeChecked();
  expect(await readFile(path, 'utf8')).toContain('Tail only,600');
});

test('late distinct responses cannot replace the value choices of a different column menu', async ({ page }) => {
  holdDistinct = true;
  await page.getByRole('button', { name: 'Filter Product', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Column filter', exact: true });
  await menu.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('values');
  await expect.poll(() => Boolean(releaseDistinct)).toBe(true);
  await page.keyboard.press('Escape'); holdDistinct = false;
  await page.getByRole('button', { name: 'Filter Region', exact: true }).click();
  await menu.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('values');
  await expect(menu.getByRole('checkbox', { name: 'Asia', exact: true })).toBeVisible();
  hostPrompts?.dispose();
  releaseDistinct?.();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(menu.getByRole('checkbox', { name: 'Asia', exact: true })).toBeVisible();
  await expect(menu.getByRole('checkbox', { name: 'Product 600', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('checkbox', { name: '10', exact: true })).toBeVisible();
});

test('inline cell editing anchors to the cell, grows within the viewport, cancels, and commits multiline values with Undo', async ({ page }) => {
  const cell = page.locator('[data-index="0"][data-col="1"]');
  const cellBox = (await cell.boundingBox())!;
  await cell.dblclick();
  const input = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await expect(input).toHaveValue('line one\nline two');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  const initial = (await input.boundingBox())!;
  expect(Math.abs(initial.x - cellBox.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(initial.y - cellBox.y)).toBeLessThanOrEqual(3);
  await input.fill(Array.from({ length: 200 }, (_, index) => `Long paragraph ${index}: ${'x'.repeat(150)}`).join('\n'));
  const grown = (await input.boundingBox())!;
  expect(grown.height).toBeGreaterThan(initial.height);
  expect(grown.x).toBeGreaterThanOrEqual(0); expect(grown.y).toBeGreaterThanOrEqual(0);
  expect(grown.x + grown.width).toBeLessThanOrEqual(1000);
  expect(grown.y + grown.height).toBeLessThanOrEqual(650);
  expect(await input.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await input.press('Escape');
  await expect(input).toBeHidden(); expect(file.changes).toBe(0);
  await cell.dblclick(); await input.fill('First');
  await input.press('Shift+Enter'); await input.press('End'); await page.keyboard.type('Second');
  await input.press('Enter');
  await expect(input).toBeHidden();
  await expect.poll(async () => (await file.page(0, 1)).rows[0]?.values[1]).toBe('First\nSecond');
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click();
  await expect.poll(async () => (await file.page(0, 1)).rows[0]?.values[1]).toBe('line one\nline two');
  expect(await readFile(path, 'utf8')).toContain('"line one\nline two"');
});

test('Save commits a pending inline value and writes directly', async ({ page }) => {
  await page.locator('[data-index="0"][data-col="0"]').dblclick();
  const input = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await input.fill('Pending inline save');
  await page.keyboard.press('ControlOrMeta+s');
  const save = page.getByRole('dialog', { name: 'Save CSV', exact: true });
  await expect(input).toBeHidden();
  expect((await file.page(0, 1)).rows[0]?.values[0]).toBe('Pending inline save');
  await expect(save).toBeHidden();
  await expect.poll(async () => (await readFile(path, 'utf8')).includes('Pending inline save')).toBe(true);
});

test('double-click row pin stays fixed and copy edit paste export retain source coordinates', async ({ page }) => {
  const source = await readFile(path, 'utf8');
  await page.getByRole('button', { name: 'Move row 3', exact: true }).dblclick();
  await expect(page.locator('.grid-row.pinned')).toHaveCount(1);
  await expectColumnStart(page, 0, ['Product 598', 'Product 600', 'Product 599']);
  expect(file.changes).toBe(0); expect(await readFile(path, 'utf8')).toBe(source);
  const synchronous = await page.evaluate(() => {
    const viewport = document.querySelector('.viewport')!;
    const pinned = document.querySelector('.grid-row.pinned')!;
    const before = pinned.getBoundingClientRect().top;
    viewport.scrollTop = 300;
    return { before, after: pinned.getBoundingClientRect().top };
  });
  expect(synchronous.after).toBeCloseTo(synchronous.before, 1);
  await page.locator('.viewport').evaluate(node => { node.scrollTop = 0; });
  await expectColumnStart(page, 0, ['Product 598', 'Product 600']);
  await selectRectangle(page, 0, 0, 1, 0);
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboardText).toContain('Product 598');
  expect(parse(clipboardText, { delimiter: '\t' })).toEqual([['Product 598'], ['Product 600']]);
  await selectRectangle(page, 0, 3, 1, 3); await calculateSelection(page);
  await expect(page.locator('.status')).toContainText('Sum 2 · AVG 1');
  await page.locator('.cell[data-index="0"][data-col="0"]').dblclick();
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Pinned edited');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).press('Enter');
  await expect(page.locator('.grid-row.pinned .cell[data-col="0"]')).toHaveText('Pinned edited');
  await selectRectangle(page, 0, 3, 0, 3); clipboardText = '77';
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.grid-row.pinned .cell[data-col="3"]')).toHaveText('77');
  expect((await file.textPage(3, 1)).text).toContain('Pinned edited,');
  await toolbarCommand(page, 'File', 'Export filtered rows and visible columns to another CSV file');
  await expect.poll(() => readFile(join(directory, 'export.csv'), 'utf8').catch(() => '')).toContain('Pinned edited,');
  const exported = parse(await readFile(join(directory, 'export.csv'), 'utf8'));
  expect(exported[1][0]).toBe('Product 600'); expect(exported[3][0]).toBe('Pinned edited'); expect(exported[3][3]).toBe('77');
  expect(await readFile(path, 'utf8')).toBe(source);
  await page.getByRole('button', { name: 'Sort Amount', exact: true }).dblclick();
  await expectColumnStart(page, 0, ['Pinned edited', 'Product 600']);
  await numberFilter(page, 'Amount', 'gte', '78');
  await expect(page.locator('.grid-row.pinned')).toHaveCount(0);
  await page.getByRole('button', { name: 'Filter Amount', exact: true }).click();
  await page.getByRole('button', { name: 'Reset column filter', exact: true }).click();
  await expect(page.locator('.grid-row.pinned')).toHaveCount(1);
  await page.getByRole('button', { name: 'Move row 3', exact: true }).dblclick();
  await expect(page.locator('.grid-row.pinned')).toHaveCount(0);
  await expectColumnStart(page, 0, ['Product 600', 'Product 599']);
});

test('pinned rows keep a scrollable body in narrow windows and keyboard handles unpin them', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 400 });
  for (let row = 1; row <= 6; row++) {
    const handle = page.getByRole('button', { name: `Move row ${row}`, exact: true });
    await handle.dblclick(); await expect(page.locator('.grid-row.pinned')).toHaveCount(row);
  }
  const dimensions = await page.evaluate(() => {
    const pinned = document.querySelector<HTMLElement>('.pinned-rows')!, viewport = document.querySelector<HTMLElement>('.viewport')!;
    return { height: pinned.clientHeight, scroll: pinned.scrollHeight, viewport: viewport.clientHeight };
  });
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.viewport / 2);
  expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
  await page.locator('.pinned-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
  const handle = page.getByRole('button', { name: 'Move row 6', exact: true });
  await handle.focus(); await handle.press('Enter');
  await expect(page.locator('.grid-row.pinned')).toHaveCount(5);
  await expect(page.locator('.grid-row:not(.pinned) .cell[data-col="0"]').first()).toHaveText('Product 595');
  expect(file.changes).toBe(0);
});

test('row handles move complete quoted records as one undoable edit and refuse dragging queried views', async ({ page }) => {
  const source = 'A,B\r\nfirst,plain\r\nsecond,"line one\nline two, ""quoted"""\r\nthird,last\r\n';
  await replaceSource(page, source, 'first');
  await page.locator('.cell[data-index="2"][data-col="1"]').dblclick();
  const edit = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await edit.fill('edited last'); await edit.press('Enter');
  await page.locator('.cell[data-index="0"][data-col="0"]').click();
  await expect(page.locator('.cell.modified')).toHaveText('edited last');
  const handle = page.getByRole('button', { name: 'Move row 2', exact: true });
  const from = (await handle.boundingBox())!;
  const to = (await page.locator('.grid-row').first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 2, { steps: 8 });
  await expect(page.locator('.row-drop-indicator')).toBeVisible();
  const preview = page.locator('.row-drag-preview');
  await expect(preview).toContainText('second');
  await expect(preview).toContainText('line one');
  expect(await preview.evaluate(node => Number(getComputedStyle(node).opacity))).toBe(.35);
  const previewBox = (await preview.boundingBox())!;
  expect(previewBox.width).toBe((await page.locator('.viewport').boundingBox())!.width);
  const previousTheme = await page.locator('html').getAttribute('data-theme');
  await page.locator('html').evaluate(node => node.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-row-drag-light.png') });
  await page.locator('html').evaluate(node => node.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-row-drag-dark.png') });
  await page.locator('html').evaluate((node, theme) => theme === null ? node.removeAttribute('data-theme') : node.setAttribute('data-theme', theme), previousTheme);
  await page.mouse.up();
  await expectColumnStart(page, 0, ['second', 'first', 'third']);
  expect((await file.page(0, 1)).rows[0]?.values[1]).toBe('line one\nline two, "quoted"');
  await expect(page.locator('.cell.modified')).toHaveText('edited last');
  expect(await readFile(path, 'utf8')).toBe(source);
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click();
  await expectColumnStart(page, 0, ['first', 'second', 'third']);
  await expect(page.locator('.cell.modified')).toHaveText('edited last');
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click();
  await expect(page.locator('.cell.modified')).toHaveCount(0);
  await expect(page.locator('.cell[data-index="2"][data-col="1"]')).toHaveText('last');
  expect(file.changes).toBe(0);
  await page.getByRole('button', { name: 'Redo (Ctrl/Cmd+Shift+Z)', exact: true }).click();
  await expect(page.locator('.cell.modified')).toHaveText('edited last');
  await page.getByRole('button', { name: 'Redo (Ctrl/Cmd+Shift+Z)', exact: true }).click();
  await expectColumnStart(page, 0, ['second', 'first', 'third']);
  await expect(page.locator('.cell.modified')).toHaveText('edited last');
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect.poll(async () => parse(await readFile(path, 'utf8'))[1]?.[0]).toBe('second');
  await page.getByRole('button', { name: 'Sort A', exact: true }).dblclick();
  await expectColumnStart(page, 0, ['first', 'second', 'third']);
  await expect(page.getByRole('button', { name: 'Move row 1', exact: true })).toBeEnabled();
  const before = (await file.page(0, 3)).rows.map(row => row.values[0]);
  await expect(page.getByRole('button', { name: 'Move row 1', exact: true })).toHaveAttribute('data-tooltip', 'Double-click: pin or unpin · Clear sorting and filters: drag rows');
  const fromQuery = (await page.getByRole('button', { name: 'Move row 1', exact: true }).boundingBox())!;
  const toQuery = (await page.locator('.grid-row').last().boundingBox())!;
  await page.mouse.move(fromQuery.x + fromQuery.width / 2, fromQuery.y + fromQuery.height / 2); await page.mouse.down();
  await page.mouse.move(toQuery.x + 20, toQuery.y + toQuery.height - 2, { steps: 8 }); await page.mouse.up();
  expect((await file.page(0, 3)).rows.map(row => row.values[0])).toEqual(before);
});

test('pinning a selected group of columns preserves their relative order and unpins the same group', async ({ page }) => {
  const first = (await page.locator('.column-heading[data-col="0"] .column-label').boundingBox())!;
  const last = (await page.locator('.column-heading[data-col="3"] .column-label').boundingBox())!;
  await page.mouse.move(first.x + 4, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(last.x + 4, last.y + last.height / 2, { steps: 7 }); await page.mouse.up();
  await columnMenu(page, 'Product');
  await page.getByRole('button', { name: 'Pin 4 selected columns to left', exact: true }).click();
  await expect(page.locator('.column-heading.frozen')).toHaveCount(4);
  expect(await page.locator('.column-heading.frozen').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.col))).toEqual(['0', '1', '2', '3']);
  await page.mouse.move(first.x + 4, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(last.x + 4, last.y + last.height / 2, { steps: 7 }); await page.mouse.up();
  await columnMenu(page, 'Product');
  await page.getByRole('button', { name: 'Unpin 4 selected columns', exact: true }).click();
  await expect(page.locator('.column-heading.frozen')).toHaveCount(0);
  expect(file.changes).toBe(0);
});

test('Shift-click extends and shrinks row and column ranges from their original anchor', async ({ page }) => {
  await page.locator('.row-number[data-index="1"]').click();
  await page.locator('.row-number[data-index="4"]').click({ modifiers: ['Shift'] });
  await expect(page.locator('.status')).toContainText('4 rows × 7 columns');
  await expect(page.locator('.row-number.axis-selected')).toHaveText(['2', '3', '4', '5']);
  await page.locator('.row-number[data-index="2"]').click({ modifiers: ['Shift'] });
  await expect(page.locator('.status')).toContainText('2 rows × 7 columns');
  await page.locator('.column-heading[data-col="1"] .column-label').click();
  await page.locator('.column-heading[data-col="3"] .column-label').click({ modifiers: ['Shift'] });
  await expect(page.locator('.status')).toContainText('600 rows × 3 columns');
  await page.locator('.column-heading[data-col="2"] .column-label').click({ modifiers: ['Shift'] });
  await expect(page.locator('.status')).toContainText('600 rows × 2 columns');
});

test('modifier-clicked cells calculate and fill only exact sparse points and reject ambiguous clipboard rectangles', async ({ page }) => {
  await selectRectangle(page, 0, 3, 0, 3);
  await page.locator('[data-index="1"][data-col="4"]').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.status')).toContainText('2 rows · 2 columns · 2 cells');
  await expect(page.locator('.status')).toContainText('Sum 2');
  await expect(page.locator('.status')).toContainText('AVG 1');
  clipboardText = 'unchanged';
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.locator('.status')).toContainText('rectangular');
  expect(clipboardText).toBe('unchanged');
  await page.keyboard.press('ControlOrMeta+x');
  await expect(page.locator('.status')).toContainText('rectangular'); expect(file.changes).toBe(0);
  await page.locator('.cell.selected[role="gridcell"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fill selection…', exact: true }).click();
  const fill = page.getByRole('dialog', { name: 'Fill selected cells', exact: true });
  await fill.getByRole('textbox', { name: 'Value', exact: true }).fill('9');
  await fill.getByRole('button', { name: 'Fill cells', exact: true }).click();
  await expect.poll(async () => (await file.page(0, 2)).rows.map(row => [row.values[3], row.values[4]])).toEqual([['9', '10'], ['1', '9']]);
  expect(await readFile(path, 'utf8')).toContain('https://example.com/0,0,10');
});

test('language settings localize workflows and persist across remount without translating CSV content', async ({ page }) => {
  await writeFile(path, (await readFile(path, 'utf8')).replace(/^Product,/, 'File,').replace('Product 600,', 'Save,'));
  await file.reload(); await file.search({ text: 'Save', limit: 1 });
  await page.evaluate(data => { window.postMessage({ type: 'metadata', data }, '*'); window.postMessage({ type: 'viewReset' }, '*'); }, metadata);
  const original = await readFile(path, 'utf8');
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await changeLanguage(page, 'zh-CN');
  await expect(page.getByRole('button', { name: '文件', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '视图', exact: true })).toBeVisible();
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('File');
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Save');
  await page.locator('.column-heading[data-col="0"] .column-filter-button').click();
  const filter = page.locator('.column-menu');
  await expect(filter.getByRole('button', { name: '应用筛选', exact: true })).toBeVisible();
  await expect(filter.getByRole('button', { name: '重置此列的筛选', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('dialog', { name: '文件命令', exact: true }).getByRole('button', { name: /保存.*Ctrl/ }).click();
  const save = page.getByRole('dialog', { name: '保存 CSV', exact: true });
  await expect(save).toBeHidden();
  await page.evaluate(() => window.postMessage({ type: 'savePrompt', saveAs: false, allowDiscard: true }, '*'));
  await expect(save.getByRole('button', { name: '不保存', exact: true })).toBeVisible();
  await save.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.toolbar button[data-l10n-label="Help: Quick guide"]').click();
  const guide = page.locator('.quick-guide');
  await expect(guide.locator('.guide-body')).toContainText(/[\p{Script=Han}]/u);
  await expect(guide.getByRole('button', { name: '下一步', exact: true })).toBeVisible();
  await guide.getByRole('button', { name: '跳过', exact: true }).click();
  await page.locator('.guide-reminder').getByRole('button', { name: '知道了', exact: true }).click();
  await expect.poll(() => languageRequests).toEqual(['zh-CN']);
  await page.goto('about:blank'); await mountGrid(page, 'Save');
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置命令', exact: true });
  const bounds = await settings.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  expect(await page.locator('.toolbar').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await settings.getByRole('button', { name: '语言', exact: true }).click();
  await settings.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
  expect(await readFile(path, 'utf8')).toBe(original);
});

test('changing language preserves unsaved Text edits and the insertion position', async ({ page }) => {
  const original = await readFile(path, 'utf8');
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const content = page.locator('.cm-content');
  await content.focus(); await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.keyboard.type('X');
  await changeLanguage(page, 'zh-CN');
  await expect(content).toContainText('ProXduct');
  await content.focus(); await page.keyboard.type('Y');
  await changeLanguage(page, 'en');
  await expect(content).toContainText('ProXYduct');
  await page.getByRole('button', { name: 'Switch to Table mode', exact: true }).click();
  await expect(page.locator('.column-heading[data-col="0"] .column-label')).toHaveText('ProXYduct');
  expect(await readFile(path, 'utf8')).toBe(original);
});

for (const modifier of ['Control', 'Meta']) test(`${modifier}+A selects all table cells from page, heading, toolbar and grid focus`, async ({ page }) => {
  for (const target of ['body', '.column-heading[data-col="0"]', '.toolbar button', '.viewport']) {
    await page.locator(target).first().evaluate(node => (node as HTMLElement).focus());
    await page.keyboard.press(`${modifier}+a`);
    await expect(page.locator('.status')).toContainText('600 rows × 7 columns');
    await expect(page.locator('[role="gridcell"][aria-selected="false"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
    await page.locator('[role="gridcell"]').first().click();
  }
});

test('Select all preserves native text selection in cell editing and filter inputs', async ({ page }) => {
  await page.locator('[role="gridcell"]').first().dblclick();
  const input = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await input.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(1, 1));
  await input.press('ControlOrMeta+a');
  expect(await input.evaluate(node => { const input = node as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd); })).toBe('Product 600');
  await input.press('Escape');
  await page.locator('.column-filter-button').first().click();
  const filter = page.getByRole('textbox', { name: 'Filter column by text' });
  await filter.fill('Product'); await filter.press('ControlOrMeta+a');
  expect(await filter.evaluate(node => { const input = node as HTMLInputElement; return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0); })).toBe('Product');
  await expect(page.locator('.status')).not.toContainText('600 rows × 7 columns');
});

test('Corner selects the whole table and double-clicking separators fits every column and visible row', async ({ page }) => {
  await page.getByRole('button', { name: 'Select all cells', exact: true }).click();
  await expect(page.locator('.status')).toContainText('600 rows × 7 columns');
  await expect(page.locator('[role="gridcell"]').first()).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('separator', { name: 'Resize Product', exact: true }).dblclick();
  await expect.poll(async () => page.locator('.column-heading[data-col="3"]').evaluate(node => node.getBoundingClientRect().width)).not.toBe(180);
  await expect(page.locator('.status')).toContainText('600 rows × 7 columns');
  await page.locator('.row-resize').first().dblclick();
  await expect.poll(async () => page.locator('.grid-row').first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(30);
  await page.locator('.viewport').evaluate(node => { node.scrollTop = 16000; });
  await expect.poll(async () => Number(await page.locator('.grid-row .row-number').first().textContent())).toBeGreaterThan(300);
  await expect.poll(async () => page.locator('.grid-row').first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(30);
});

test('Native Table and Text scrollbars retain visible tracks across themes without hovering', async ({ page }) => {
  const viewport = page.locator('.viewport');
  await expect.poll(async () => viewport.evaluate(node => ({ x: (node as HTMLElement).offsetWidth - node.clientWidth, y: (node as HTMLElement).offsetHeight - node.clientHeight }))).toEqual({ x: 8, y: 8 });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /Switch to (light|dark)/ }).click();
    await page.mouse.move(0, 0);
    await expect(viewport).toHaveJSProperty('scrollTop', 0);
    await page.screenshot({ path: join(tmpdir(), `vscode-csv-scrollbars-${theme}.png`) });
    expect(await page.locator('.column-headings').evaluate(node => node.getBoundingClientRect().width)).toBe(await viewport.evaluate(node => node.clientWidth));
    expect(await viewport.evaluate(node => getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  }
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  const scroller = page.locator('.cm-scroller');
  await expect(scroller).toBeVisible();
  await expect.poll(async () => scroller.evaluate(node => (node as HTMLElement).offsetWidth - node.clientWidth)).toBe(8);
  expect(await scroller.evaluate(node => getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-scrollbars-text.png') });
});


test('editor prompts validate typed fields, preserve keyboard cancellation and stack above recovery', async ({ page }) => {
  const show = (prompt: HostPrompt) => page.evaluate(prompt => window.postMessage({ type: 'prompt', prompt }, '*'), prompt);
  await page.setViewportSize({ width: 380, height: 640 });
  await show({ id: 101, kind: 'choice', title: 'Confirm scan', detail: 'The complete file will be scanned.', choices: [{ id: 'continue', label: 'Continue' }] });
  const dialog = page.getByRole('dialog', { name: 'Confirm scan', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => promptAnswers.at(-1)).toEqual({ id: 101, value: null });
  await show({ id: 102, kind: 'input', title: 'File path', value: '/tmp/sample.copy.csv', choices: [{ id: 'system', label: 'Choose another location…' }] });
  const input = page.getByRole('textbox', { name: 'File path', exact: true });
  await expect(input).toBeFocused(); await input.fill('/tmp/edited.csv'); await input.press('Enter');
  await expect.poll(() => promptAnswers.at(-1)).toEqual({ id: 102, value: '/tmp/edited.csv' });
  await show({ id: 103, kind: 'form', title: 'Backup preferences', fields: [{ id: 'enabled', label: 'Enable backups', type: 'checkbox', value: true }, { id: 'limit', label: 'Storage MB', type: 'number', min: 1, value: '500' }] });
  await page.getByRole('spinbutton', { name: 'Storage MB' }).fill('0');
  await page.getByRole('dialog', { name: 'Backup preferences' }).getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a valid value');
  expect(promptAnswers.at(-1)?.id).toBe(102);
  await page.getByRole('spinbutton', { name: 'Storage MB' }).fill('600'); await page.getByRole('checkbox', { name: 'Enable backups' }).uncheck();
  await page.getByRole('spinbutton', { name: 'Storage MB' }).press('Enter');
  await expect.poll(() => promptAnswers.at(-1)).toEqual({ id: 103, value: { enabled: false, limit: '600' } });
  await toolbarCommand(page, 'File', 'Recover a saved version');
  const recover = page.getByRole('dialog', { name: 'Recover CSV', exact: true });
  await expect(recover).toBeVisible();
  await show({ id: 104, kind: 'choice', title: 'Confirm cleanup', choices: [{ id: 'delete', label: 'Delete saved versions' }] });
  await page.getByRole('dialog', { name: 'Confirm cleanup' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(recover).toBeVisible();
});

test('real header names edit inline, undo without clearing filters and save as CSV headers', async ({ page }) => {
  const label = page.locator('.column-heading[data-col="0"] .column-label');
  const heading = page.locator('.column-heading[data-col="0"]');
  await heading.dblclick({ position: { x: 2, y: 15 } });
  const input = page.locator('.inline-cell-input');
  await expect(input).toBeVisible();
  const bounds = (await heading.boundingBox())!;
  const editorBounds = (await page.locator('.inline-cell-editor').boundingBox())!;
  expect(editorBounds.y).toBe(bounds.y); expect(editorBounds.x).toBe(bounds.x);
  await input.press('Escape');
  await label.dblclick();
  await expect(input).toBeVisible(); await input.fill('Renamed, product'); await input.press('Enter');
  await expect(label).toHaveText('Renamed, product');
  expect(metadata.modifiedHeaders).toEqual([0]);
  await page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true }).click(); await expect(label).toHaveText('Product');
  await page.getByRole('button', { name: 'Redo (Ctrl/Cmd+Shift+Z)', exact: true }).click(); await expect(label).toHaveText('Renamed, product');
  await toolbarCommand(page, 'File', 'Save (Ctrl/Cmd+S)');
  await expect.poll(async () => (await readFile(path, 'utf8')).startsWith('"Renamed, product",Note,')).toBe(true);
});

test('small CSV retains slim scroll tracks and row gutter follows source row digits', async ({ page }) => {
  await replaceSource(page, 'A,B\n1,2\n', '1');
  const viewport = page.locator('.viewport');
  await expect.poll(() => viewport.evaluate(node => ({ x: (node as HTMLElement).offsetWidth - node.clientWidth, y: (node as HTMLElement).offsetHeight - node.clientHeight }))).toEqual({ x: 8, y: 8 });
  const width = await page.locator('.row-number').first().evaluate(node => node.getBoundingClientRect().width);
  await page.evaluate(data => window.postMessage({ type: 'metadata', data: { ...data, rows: 1000000000 } }, '*'), metadata);
  await expect.poll(() => page.locator('.row-number').first().evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(width);
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await expect.poll(() => page.locator('.cm-scroller').evaluate(node => (node as HTMLElement).offsetWidth - node.clientWidth)).toBe(8);
});


test('large-file sorting confirms through the host policy with matching footer actions', async ({ page }) => {
  metadata = { ...metadata, bytes: 30 * 1024 * 1024 };
  const original = await readFile(path, 'utf8');
  await page.setViewportSize({ width: 420, height: 640 });
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick();
  const dialog = page.getByRole('dialog', { name: 'Sorting or filtering this large file may take a long time.', exact: true });
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true }), proceed = dialog.getByRole('button', { name: 'Continue', exact: true });
  const a = (await cancel.boundingBox())!, b = (await proceed.boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(1); expect(a.height).toBe(b.height); expect(a.width).toBe(b.width); expect(a.x).toBeLessThan(b.x);
  expect(await proceed.evaluate(node => getComputedStyle(node).textAlign)).toBe('center');
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 600');
  await page.screenshot({ path: join(tmpdir(), 'vscode-csv-large-query-confirmation.png') });
  await cancel.click(); await expect(dialog).toBeHidden();
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 600');
  await page.getByRole('button', { name: 'Sort Product', exact: true }).dblclick(); await proceed.click();
  await expect(page.locator('[data-index="0"][data-col="0"]')).toHaveText('Product 001');
  expect(await readFile(path, 'utf8')).toBe(original);
});

async function deleteColumn(page: Page, name: string): Promise<void> {
  await page.getByRole('columnheader').filter({ has: page.locator('.column-label', { hasText: new RegExp(`^${name}$`) }) }).locator('.column-label').click();
  await columnMenu(page, name);
  await page.getByRole('button', { name: 'Delete selected columns…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete selected columns', exact: true }).getByRole('button', { name: 'Delete columns', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete selected columns', exact: true })).toBeHidden();
}

async function deleteRow(page: Page, index: number): Promise<void> {
  const number = page.locator(`.row-number[data-index="${index}"]`);
  await number.click({ position: { x: 45, y: 15 } });
  await number.click({ button: 'right', position: { x: 45, y: 15 } });
  await page.getByRole('menuitem', { name: 'Delete selected rows…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete selected rows', exact: true }).getByRole('button', { name: 'Delete rows', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete selected rows', exact: true })).toBeHidden();
}

test('deleting rows and columns keeps cells contiguous and Undo restores independent edits', async ({ page }) => {
  const source = 'A,B,C,D\na1,b1,c1,d1\na2,b2,c2,d2\na3,b3,c3,d3\na4,b4,c4,d4\n';
  await replaceSource(page, source, 'a1');
  await page.locator('.cell[data-index="3"][data-col="2"]').dblclick();
  const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await editor.fill('edited'); await editor.press('Enter');
  await deleteColumn(page, 'B'); await deleteRow(page, 1);
  await expectColumnStart(page, 0, ['a1', 'a3', 'a4']);
  await expect(page.locator('.cell.modified')).toHaveText('edited');
  const a = (await page.locator('.cell[data-index="0"][data-col="0"]').boundingBox())!;
  const c = (await page.locator('.cell[data-index="0"][data-col="1"]').boundingBox())!;
  const next = (await page.locator('.cell[data-index="1"][data-col="0"]').boundingBox())!;
  expect(c.x - a.x - a.width).toBe(0); expect(next.y - a.y - a.height).toBe(0);
  await selectRectangle(page, 0, 0, 1, 1); await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboardText).toBe('a1\tc1\na3\tc3');
  const undo = page.getByRole('button', { name: 'Undo (Ctrl/Cmd+Z)', exact: true });
  await undo.click(); await expectColumnStart(page, 0, ['a1', 'a2', 'a3', 'a4']);
  await expect(page.locator('.cell.modified')).toHaveText('edited');
  await undo.click(); await expect(page.locator('.column-heading[data-col="1"] .column-label')).toHaveText('B');
  await expect(page.locator('.cell.modified')).toHaveAttribute('data-col', '2');
  await undo.click(); await expect(page.locator('.cell.modified')).toHaveCount(0);
  expect(file.changes).toBe(0); expect(await readFile(path, 'utf8')).toBe(source);
});

test('Copy with headers is explicit while keyboard Copy remains content-only', async ({ page }) => {
  await selectRectangle(page, 0, 0, 1, 1);
  await page.keyboard.press('ControlOrMeta+c');
  const contents = 'Product 600\t"line one\nline two"\nProduct 599\t"line one\nline two"';
  await expect.poll(() => clipboardText).toBe(contents);
  const cell = page.locator('.cell[data-index="0"][data-col="0"]');
  await cell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy with headers', exact: true }).click();
  await expect.poll(() => clipboardText).toBe('Product\tNote\n' + contents);
  await expect(page.locator('.clipboard-source')).not.toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboardText).toBe(contents);
  expect(file.changes).toBe(0);
});
