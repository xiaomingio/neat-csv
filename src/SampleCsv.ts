/*
Purpose: Generate deterministic CSV samples in chunks with multiline text, links, empty fields, and mixed values.
*/
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export class SampleCsv {
  static async create(path: string, size: 'small' | 'large'): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx');
    try {
      await file.writeFile('ID,Product,Category,Price,Quantity,Discount,Active,Date,Website,Related links,Description,Notes,City,Email,Code,Rating,Stock,Tags,Empty,Mixed\r\n');
      const total = size === 'large' ? 50000 : 60;
      for (let start = 1; start <= total; start += 256) {
        const rows: string[] = [];
        for (let id = start; id < Math.min(start + 256, total + 1); id++) {
          const values = [String(id), ['Mechanical keyboard', 'Portable display ✨', 'Studio headphones 🎧', 'Travel mug'][id % 4] + ` ${id}`,
            ['Electronics', 'Home', 'Office'][id % 3], (id * 7.31 % 900).toFixed(2), String(id % 40), id % 7 ? '0.15' : '',
            id % 2 ? 'true' : 'false', `2026-10-${String(id % 28 + 1).padStart(2, '0')}`,
            `https://example.com/products/${id}?ref=csv&lang=en`, `Product details: https://example.org/item/${id} — Shipping help: https://example.net/help#shipping. Contact us if you need assistance.`,
            id % 3 ? 'A long description for checking horizontal scrolling, column resizing, and text selection. Read https://example.com/docs/product-care for care instructions, then continue editing this quoted CSV field without losing the original record.'
              : 'First line: a product with multiple paragraphs.\nSecond line contains commas, "quoted details", and Unicode symbols: café, € and 🎧. See https://example.org/guides/setup for setup instructions.\nThird line: check https://example.net/help#returns for returns, or double-click the row divider to read everything.',
            id % 5 ? 'Includes cable, stand, and "quick start" guide' : '', ['Shanghai', 'Tokyo', 'Munich', 'New York'][id % 4],
            `user${id}@example.com`, String(id).padStart(8, '0'), id % 6 ? (id % 50 / 10).toFixed(1) : '', String(id % 300),
            'demo, review, multiline', '', id % 4 ? String(id * 13) : 'Contact support'];
          rows.push(values.map(value => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(','));
        }
        await file.writeFile(rows.join('\r\n') + '\r\n');
      }
      await file.close();
      await rename(temp, path);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
}
