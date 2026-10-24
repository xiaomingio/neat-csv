/*
Purpose: Verify reverse dragging and copy-coordinate boundaries after selection reset.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellSelection } from '../src/webview/CellSelection';

test('Reverse selection covers the complete visual rectangle and reset clears the copy range', () => {
  const selection = new CellSelection();
  selection.start(8, 5); selection.extend(2, 1);
  assert.deepEqual(selection.bounds, { firstRow: 2, lastRow: 8, firstCol: 1, lastCol: 5 });
  assert.equal(selection.contains(5, 3), true);
  assert.equal(selection.contains(1, 3), false);
  assert.equal(selection.contains(5, 6), false);
  selection.clear();
  assert.equal(selection.bounds, undefined);
  assert.equal(selection.contains(5, 3), false);
  selection.start(0, 0);
  assert.deepEqual(selection.bounds, { firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 });
});

test('Deselecting a row splits contiguous ranges and counts only selected rows and columns', () => {
  const selection = new CellSelection();
  selection.startAxis('rows', 2, false); selection.extendAxis(6);
  selection.startAxis('rows', 4, true);
  assert.deepEqual(selection.snapshot(20, 3), {
    ranges: [{ start: 2, count: 2 }, { start: 5, count: 2 }], columns: [0, 1, 2], rowCount: 4, columnCount: 3,
  });
  assert.equal(selection.contains(4, 1), false);
  assert.equal(selection.contains(5, 1), true);
  selection.startAxis('columns', 0, false); selection.extendAxis(4);
  selection.startAxis('columns', 2, true);
  assert.deepEqual(selection.snapshot(20, 5), {
    ranges: [{ start: 0, count: 20 }], columns: [0, 1, 3, 4], rowCount: 20, columnCount: 4,
  });
});

test('Reverse column dragging can shrink to its anchor and changing selection direction replaces the previous range', () => {
  const selection = new CellSelection();
  selection.startAxis('columns', 4, false); selection.extendAxis(1);
  assert.deepEqual(selection.snapshot(10, 6)?.columns, [1, 2, 3, 4]);
  selection.extendAxis(3);
  assert.deepEqual(selection.snapshot(10, 6)?.columns, [3, 4]);
  selection.extendAxis(4);
  assert.deepEqual(selection.snapshot(10, 6)?.columns, [4]);
  selection.startAxis('rows', 2, true);
  assert.deepEqual(selection.snapshot(10, 6), {
    ranges: [{ start: 2, count: 1 }], columns: [0, 1, 2, 3, 4, 5], rowCount: 1, columnCount: 6,
  });
});

test('Select all tracks progressively indexed rows with one range and is replaced by ordinary selection', () => {
  const selection = new CellSelection();
  selection.selectAll();
  assert.equal(selection.isAll(500, 4), true);
  assert.deepEqual(selection.snapshot(2_000_000, 4), { ranges: [{ start: 0, count: 2_000_000 }], columns: [0, 1, 2, 3], rowCount: 2_000_000, columnCount: 4 });
  assert.equal(selection.contains(1_999_999, 3), true);
  selection.start(2, 1); assert.equal(selection.isAll(500, 4), false);
  selection.start(0, 0); selection.extend(499, 3); assert.equal(selection.isAll(500, 4), true);
  selection.clear(); assert.equal(selection.snapshot(500, 4), undefined);
});

test('Selecting issue rows preserves disjoint rows without selecting intervening rows', () => {
  const selection = new CellSelection();
  selection.selectRows([11, 3, 2, 3, 15]);
  assert.deepEqual(selection.snapshot(20, 5), { ranges: [{ start: 2, count: 2 }, { start: 11, count: 1 }, { start: 15, count: 1 }], columns: [0, 1, 2, 3, 4], rowCount: 4, columnCount: 5 });
  assert.equal(selection.contains(4, 1), false);
  assert.equal(selection.contains(11, 4), true);
  selection.selectRows([]); assert.equal(selection.snapshot(20, 5), undefined);
});

test('Modifier cell toggles preserve exact diagonal points, compress complete products, and preserve a large selection on refusal', () => {
  const selection = new CellSelection();
  selection.start(2, 1); selection.toggle(8, 4, 100, 8);
  assert.deepEqual(selection.snapshot(100, 8)?.cells, [{ row: 2, col: 1 }, { row: 8, col: 4 }]);
  assert.equal(selection.contains(2, 4), false);
  assert.equal(selection.contains(8, 1), false);
  assert.equal(selection.isAll(2, 2), false);
  selection.toggle(2, 4, 100, 8); selection.toggle(8, 1, 100, 8);
  assert.deepEqual(selection.snapshot(100, 8), { ranges: [{ start: 2, count: 1 }, { start: 8, count: 1 }], columns: [1, 4], rowCount: 2, columnCount: 2 });
  selection.toggle(8, 4, 100, 8); assert.equal(selection.snapshot(100, 8)?.cells?.length, 3);
  selection.selectAll();
  assert.throws(() => selection.toggle(0, 0, 2_000_000, 20), /100,000/);
  assert.equal(selection.isAll(2_000_000, 20), true);
});

test('Shift axis clicks retain the initial anchor through reverse ranges and preserve disjoint modifier ranges', () => {
  const selection = new CellSelection();
  selection.startAxis('rows', 5, false);
  selection.startAxis('rows', 9, false, true);
  assert.deepEqual(selection.snapshot(100, 4)?.ranges, [{ start: 5, count: 5 }]);
  selection.startAxis('rows', 2, false, true);
  assert.deepEqual(selection.snapshot(100, 4)?.ranges, [{ start: 2, count: 4 }]);
  selection.startAxis('rows', 12, true);
  assert.deepEqual(selection.snapshot(100, 4)?.ranges, [{ start: 2, count: 4 }, { start: 12, count: 1 }]);
  selection.startAxis('columns', 1, false); selection.startAxis('columns', 3, false, true);
  assert.deepEqual(selection.snapshot(100, 4)?.columns, [1, 2, 3]);
});
