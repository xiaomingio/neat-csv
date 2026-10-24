/*
Purpose: Verify sparse row-height offsets, boundary lookup, and reset for virtual scrolling.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { RowLayout } from '../src/webview/RowLayout';

test('Variable heights map cumulative pixel offsets and assign boundary pixels to the next row', () => {
  const layout = new RowLayout();
  layout.set(0, 90);
  layout.set(3, 150);
  assert.deepEqual(Array.from({ length: 6 }, (_, row) => layout.offset(row)), [0, 90, 120, 150, 300, 330]);
  for (const [pixel, row] of [[0, 0], [89, 0], [90, 1], [119, 1], [120, 2], [149, 2], [150, 3], [299, 3], [300, 4], [329, 4]]) {
    assert.equal(layout.rowAt(pixel!, 5), row);
  }
  assert.equal(layout.rowAt(900, 5), 4);
  assert.equal(layout.rowAt(-20, 5), 0);
});

test('Distant sparse heights and out-of-order changes preserve offsets when rows shrink', () => {
  const layout = new RowLayout();
  layout.set(1_000_000, 120);
  layout.set(2, 90);
  assert.equal(layout.offset(1_000_000), 30_000_060);
  assert.equal(layout.offset(1_000_001), 30_000_180);
  assert.equal(layout.rowAt(30_000_179, 2_000_000), 1_000_000);
  assert.equal(layout.rowAt(30_000_180, 2_000_000), 1_000_001);
  layout.set(2, 30);
  assert.equal(layout.offset(1_000_000), 30_000_000);
  assert.equal(layout.offset(1_000_001), 30_000_120);
  assert.equal(layout.rowAt(30_000_120, 2_000_000), 1_000_001);
});

test('Height limits preserve usable rows and reset restores default coordinates', () => {
  const layout = new RowLayout();
  layout.set(0, 0);
  layout.set(1, 5000);
  assert.equal(layout.height(0), 30);
  assert.equal(layout.height(1), 600);
  assert.equal(layout.offset(2), 630);
  layout.clear();
  assert.equal(layout.height(1), 30);
  assert.equal(layout.offset(2), 60);
  assert.equal(layout.rowAt(59, 2), 1);
  assert.equal(layout.rowAt(0, 0), 0);
});

test('Repeated and unordered row changes match dense offsets after thousands of updates', () => {
  const layout = new RowLayout();
  const heights = Array<number>(2000).fill(30);
  let seed = 12345;
  for (let count = 0; count < 12000; count++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const row = seed % heights.length, height = 30 + (seed % 571);
    heights[row] = height; layout.set(row, height);
    if (count % 1000 === 0) {
      let offset = 0;
      for (let index = 0; index < heights.length; index++) {
        assert.equal(layout.offset(index), offset);
        assert.equal(layout.height(index), heights[index]);
        assert.equal(layout.rowAt(offset, heights.length), index);
        assert.equal(layout.rowAt(offset + heights[index]! - 1, heights.length), index);
        offset += heights[index]!;
      }
    }
  }
  layout.fitAll();
  assert.equal(layout.needsMeasurement(8), true);
  layout.set(8, 30); assert.equal(layout.needsMeasurement(8), false);
  layout.set(9, 90); assert.equal(layout.offset(10), 360);
  layout.resetMeasurements(); assert.equal(layout.offset(10), 300);
  assert.equal(layout.needsMeasurement(8), true);
  layout.clear(); assert.equal(layout.needsMeasurement(8), false);
});
