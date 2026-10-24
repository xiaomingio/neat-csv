/*
Capture the real CSV webview against the file engine for Marketplace documentation.
Uses temporary copies of project samples and genuinely headless Chromium.
*/
import { chromium, expect, type Page } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'csv-parse/sync';
import { CsvFile } from '../src/engine/CsvFile';
import type { ClientMessage, HostMessage, Metadata } from '../src/protocol';

class ScreenshotSession {
  private metadata!: Metadata;
  private file!: CsvFile;
  private directory = '';
  constructor(private readonly page: Page) {}
  async open(sample: 'complex' | 'large', singleLineRecords = false, view: { hidden?: number[]; widths?: Record<number, number> } = {}): Promise<void> {
    await this.close();
    this.directory = await mkdtemp(join(tmpdir(), 'csv-marketplace-'));
    const path = join(this.directory, sample + '.csv');
    await copyFile(resolve('examples', sample + '.csv'), path);
    if (singleLineRecords) {
      const records = parse(await readFile(path, 'utf8')) as string[][];
      const compact = records.filter(record => record.every(value => !/[\r\n]/.test(value))).slice(0, 16);
      await writeFile(path, compact.map(record => record.map(value => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(',')).join('\r\n') + '\r\n');
    }
    let complete!: () => void;
    const indexed = new Promise<void>(resolve => { complete = resolve; });
    this.file = new CsvFile(path, metadata => { this.metadata = metadata; if (metadata.complete) complete(); });
    await this.file.open(); await indexed;
    await this.page.goto('about:blank');
    await this.page.setContent('<html><body class="vscode-light"><div id="app"></div></body></html>');
    await this.page.addStyleTag({ content: "@layer vscode-default { html { --vscode-editor-font-family: Menlo, Monaco, monospace; } }" });
    await this.page.addStyleTag({ path: 'dist/style.css' });
    const state = { theme: 'light', alignText: true, frozen: [], hidden: view.hidden, widths: { 0: 132, 1: 240, 2: 150, 3: 140, 4: 145, 5: 145, ...view.widths } };
    await this.page.addScriptTag({ content: `window.acquireVsCodeApi = () => ({ getState: () => (${JSON.stringify(state)}), setState: () => {}, postMessage: async message => { for (const reply of await window.screenshotHost(message)) window.postMessage(reply, '*'); } });` });
    await this.page.addScriptTag({ path: 'dist/grid.js' });
    await expect(this.page.locator('.cell[data-index="0"][data-col="0"]')).toHaveText('1');
  }
  async attach(): Promise<void> {
    await this.page.exposeFunction('screenshotHost', async (message: ClientMessage): Promise<HostMessage[]> => {
      try {
        let result: unknown;
        const updates: HostMessage[] = [];
        switch (message.type) {
          case 'ready': result = this.metadata; updates.push({ type: 'language', language: 'en' }); break;
          case 'page': result = await this.file.page(message.start, message.count); break;
          case 'pinRows': result = await this.file.pinRows(message.rows); break;
          case 'query': result = await this.file.query(message.query); break;
          case 'confirmQuery': result = true; break;
          case 'edit':
            await this.file.edit(message.edit);
            updates.push({ type: 'changed', changes: this.file.changes, canUndo: true, canRedo: false }); break;
          case 'change':
            result = await this.file.change(message.operation);
            updates.push({ type: 'metadata', data: this.metadata }, { type: 'changed', changes: this.file.changes, canUndo: true, canRedo: false }); break;
          case 'stats': result = await this.file.stats(message.start, message.count, message.columns, message.ranges, message.cells); break;
          case 'textPage': result = await this.file.textPage(message.start, message.count); break;
          case 'distinct': result = await this.file.distinct(message.col); break;
          case 'check': result = await this.file.check(message.options); break;
          case 'locate': result = await this.file.locate(message.row); break;
          case 'guideSeen': break;
          default: throw new Error(`Unsupported screenshot operation: ${message.type}`);
        }
        return [...updates, { type: 'response', id: message.id, result }];
      } catch (error) { return [{ type: 'response', id: message.id, error: String(error) }]; }
    });
  }
  async capture(name: string, dragging = false): Promise<void> {
    if (!dragging) await this.page.mouse.move(1250, 700);
    await this.page.evaluate(() => document.fonts.ready);
    await this.page.screenshot({ path: resolve('docs/images', name + '.png') });
  }
  async close(): Promise<void> {
    if (this.file) await this.file.dispose();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
await mkdir('docs/images', { recursive: true });
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: 'light' });
const session = new ScreenshotSession(page);
try {
  await session.attach();
  await session.open('complex', false, { hidden: [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19], widths: { 10: 620 } });
  const multiline = page.locator('.cell[data-index="2"][data-col="10"]');
  await multiline.dblclick();
  const multilineInput = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await expect(multilineInput).toHaveValue(/First line:[\s\S]*Second line[\s\S]*Third line:/);
  await multilineInput.press('ArrowRight');
  await session.capture('edit-multiline');
  await multilineInput.press('Escape');
  await session.open('complex');
  const cell = page.locator('.cell[data-index="2"][data-col="3"]');
  await cell.dblclick();
  const input = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await input.fill('24.50'); await input.press('Enter');
  await expect(cell).toHaveClass(/modified/);
  await page.locator('.cell[data-index="0"][data-col="3"]').click();
  await page.locator('.cell[data-index="5"][data-col="4"]').click({ modifiers: ['Shift'] });
  await expect(page.locator('.status')).toContainText('AVG');
  await page.setViewportSize({ width: 1280, height: 420 });
  await expect(page.locator('.status')).toContainText('AVG');
  await session.capture('selection-statistics');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.cell[data-index="0"][data-col="3"]').click({ button: 'right' });
  await session.capture('copy-options');
  await page.keyboard.press('Escape');
  await session.open('complex', false, { hidden: [6, 7, 8, 9, 10, 12, 13, 14, 16, 17, 19], widths: { 0: 80, 1: 220, 2: 120, 3: 90, 4: 90, 5: 90, 11: 130, 15: 80, 18: 80 } });
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByRole('dialog', { name: 'Data commands', exact: true }).getByRole('button', { name: /Find duplicate values, empty cells/ }).click();
  const checks = page.getByRole('region', { name: 'Data check results', exact: true });
  await checks.getByRole('combobox', { name: 'Check', exact: true }).selectOption('missing');
  await checks.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(checks.getByRole('checkbox', { name: 'Select all listed results', exact: true })).toBeEnabled();
  await checks.getByRole('checkbox', { name: 'Select all listed results', exact: true }).check();
  await expect(page.locator('.cell[data-index="0"][data-col="18"]')).toHaveClass(/selected/);
  await expect(checks.getByRole('button', { name: 'Select checked cells', exact: true })).toBeEnabled();
  await page.locator('.cell[data-index="4"][data-col="11"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fill selection…', exact: true }).hover();
  await session.capture('data-check-empty-cells', true);
  await session.open('complex');
  await page.locator('.cell[data-index="0"][data-col="1"]').hover();
  await expect(page.locator('.toolbar-hint')).toContainText('Tips: Click and drag: select cells');
  await session.capture('operation-tips', true);
  await page.getByRole('button', { name: 'Filter Category', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Electronics');
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await expect(page.locator('.viewport')).toHaveAttribute('aria-rowcount', '20');
  await page.getByRole('button', { name: 'Filter Price', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('number');
  await page.getByRole('combobox', { name: 'Number comparison', exact: true }).selectOption('between');
  await page.getByRole('spinbutton', { name: 'Filter number', exact: true }).fill('20');
  await page.getByRole('spinbutton', { name: 'Filter maximum', exact: true }).fill('200');
  await session.capture('filters');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sort Price', exact: true }).click();
  await page.getByRole('button', { name: 'Descending', exact: true }).click();
  await expect(page.locator('.column-heading[data-col="3"]')).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('.cell[data-index="0"][data-col="3"]')).toHaveText('438.60');
  await page.getByRole('button', { name: 'Sort Price', exact: true }).click();
  await session.capture('sorting');
  await page.getByRole('button', { name: 'Original order', exact: true }).click();
  await session.open('complex', true);
  await page.getByRole('button', { name: 'Switch to Text mode', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Portable display');
  await page.setViewportSize({ width: 1280, height: 520 });
  const blockPoint = async (line: number, offset: number) => page.locator('.cm-line').nth(line).evaluate((node, offset) => {
    const text = node.querySelector('.csv-text-column-1')!.firstChild!;
    const range = document.createRange(); range.setStart(text, offset); range.collapse(true);
    const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y + rect.height / 2 };
  }, offset);
  const startBlock = await blockPoint(1, 0), endBlock = await blockPoint(10, 10);
  await page.keyboard.down('Alt'); await page.mouse.move(startBlock.x, startBlock.y); await page.mouse.down();
  await page.mouse.move(endBlock.x, endBlock.y, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(page.locator('.cm-cursor')).toHaveCount(10);
  await session.capture('text-block-edit');
  await page.setViewportSize({ width: 1280, height: 720 });

  await session.open('complex');
  await page.setViewportSize({ width: 1280, height: 420 });
  const rowLabel = (index: number) => page.locator(`.row-number[data-index="${index}"]`);
  await rowLabel(1).click({ position: { x: 45, y: 15 } });
  await rowLabel(3).click({ modifiers: ['Shift'], position: { x: 45, y: 15 } });
  await rowLabel(7).click({ modifiers: ['ControlOrMeta'], position: { x: 45, y: 15 } });
  await expect(page.locator('.row-number.axis-selected')).toHaveCount(4);
  await session.capture('select-rows');
  await page.locator('.column-heading[data-col="2"] .column-label').click();
  await page.locator('.column-heading[data-col="3"] .column-label').click({ modifiers: ['Shift'] });
  await page.locator('.column-heading[data-col="5"] .column-label').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.column-heading.axis-selected')).toHaveCount(3);
  await session.capture('select-columns');
  await page.locator('.cell[data-index="0"][data-col="3"]').click();
  await page.locator('.cell[data-index="2"][data-col="4"]').click({ modifiers: ['ControlOrMeta'] });
  await page.locator('.cell[data-index="4"][data-col="2"]').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.cell[role="gridcell"].selected')).toHaveCount(3);
  await session.capture('select-cells');
  await page.setViewportSize({ width: 1280, height: 720 });
  await session.open('complex');
  await page.getByRole('button', { name: 'Move ID', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Move Product', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Move row 1', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Move row 3', exact: true }).dblclick();
  await expect(page.locator('.grid-row.pinned')).toHaveCount(2);
  await page.locator('.viewport').evaluate(node => { node.scrollLeft = 500; node.scrollTop = 240; });
  await expect(page.locator('.column-heading.frozen')).toHaveCount(2);
  await expect(page.locator('.grid-row.pinned .cell[data-col="0"]')).toHaveText(['1', '3']);
  await page.locator('.column-heading[data-col="6"] .column-label').click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'Pin to left', exact: true })).toBeVisible();
  await session.capture('pin-rows-columns');
  await page.keyboard.press('Escape');
  await session.open('complex');
  await page.getByRole('button', { name: /Switch to dark$/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.cell[data-index="0"][data-col="3"]').click();
  await page.locator('.cell[data-index="5"][data-col="4"]').click({ modifiers: ['Shift'] });
  await expect(page.locator('.status')).toContainText('AVG');
  await session.capture('dark-mode');
  await session.open('large');
  await expect(page.locator('.status')).toContainText('50,000');
  await page.locator('.viewport').evaluate(node => { node.scrollTop = 750000; });
  await expect(page.locator('.cell[data-col="0"]').first()).not.toHaveText('1');
  await session.capture('large-file');
} finally {
  await session.close(); await browser.close();
}

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
