/*
Track rectangular, row, and column selections as distinct view ranges.
*/
type Range = { start: number; count: number };
type Axis = 'rows' | 'columns';

export class CellSelection {
  private all = false;
  private points?: Map<string, { row: number; col: number }>;
  private anchor?: { row: number; col: number };
  private focus?: { row: number; col: number };
  private axis?: Axis;
  private axisRanges: Range[] = [];
  private axisBase: Range[] = [];
  private axisAnchor = 0;
  private axisMoved = false;

  start(row: number, col: number): void {
    this.clear(); this.anchor = { row, col }; this.focus = { row, col };
  }

  extend(row: number, col: number): void {
    if (this.points) { const anchor = this.anchor; this.clear(); this.anchor = anchor; this.focus = anchor; }
    if (!this.anchor || this.axis) this.start(row, col);
    else this.focus = { row, col };
  }

  startAxis(axis: Axis, index: number, add: boolean, extend = false): void {
    const previous = add && this.axis === axis ? this.axisRanges : [];
    const anchor = extend && this.axis === axis ? this.axisAnchor : index;
    this.clear(); this.axis = axis; this.axisAnchor = anchor; this.axisBase = previous;
    if (extend) { this.axisMoved = index !== anchor; this.axisRanges = this.merge([...previous, { start: Math.min(index, anchor), count: Math.abs(index - anchor) + 1 }]); return; }
    const selected = previous.some(range => index >= range.start && index < range.start + range.count);
    this.axisRanges = selected ? previous.flatMap(range => {
      const end = range.start + range.count;
      if (index < range.start || index >= end) return [range];
      return [{ start: range.start, count: index - range.start }, { start: index + 1, count: end - index - 1 }].filter(item => item.count > 0);
    }) : this.merge([...previous, { start: index, count: 1 }]);
  }

  extendAxis(index: number): void {
    if (!this.axis || (index === this.axisAnchor && !this.axisMoved)) return;
    this.axisMoved = true;
    this.axisRanges = this.merge([...this.axisBase, { start: Math.min(index, this.axisAnchor), count: Math.abs(index - this.axisAnchor) + 1 }]);
  }

  private merge(ranges: Range[]): Range[] {
    const result: Range[] = [];
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      const last = result.at(-1);
      if (last && last.start + last.count >= range.start) last.count = Math.max(last.start + last.count, range.start + range.count) - last.start;
      else result.push({ ...range });
    }
    return result;
  }

  toggle(row: number, col: number, totalRows: number, totalColumns: number): void {
    let points = this.points;
    if (!points) {
      const selected = this.snapshot(totalRows, totalColumns);
      if (selected && selected.rowCount * selected.columnCount > 100_000) throw new Error('Add individual cells to a selection of at most 100,000 cells.');
      points = new Map();
      if (selected) for (const range of selected.ranges) for (let index = range.start; index < range.start + range.count; index++) for (const column of selected.columns) points.set(`${index}:${column}`, { row: index, col: column });
    }
    const key = `${row}:${col}`;
    if (!points.has(key) && points.size >= 100_000) throw new Error('Select at most 100,000 individual cells.');
    this.clear(); this.points = points; this.anchor = { row, col }; this.focus = this.anchor;
    if (points.has(key)) points.delete(key); else points.set(key, { row, col });
  }

  selectRows(rows: number[]): void {
    this.clear(); this.axis = 'rows';
    this.axisRanges = this.merge([...new Set(rows)].filter(row => Number.isInteger(row) && row >= 0).map(start => ({ start, count: 1 })));
  }

  selectCells(cells: { row: number; col: number }[]): void {
    this.clear();
    this.points = new Map(cells.map(cell => [`${cell.row}:${cell.col}`, cell]));
    this.anchor = cells[0]; this.focus = this.anchor;
  }

  selectAll(): void { this.clear(); this.all = true; }
  isAll(totalRows: number, totalColumns: number): boolean {
    const selected = this.snapshot(totalRows, totalColumns);
    return Boolean(totalRows && totalColumns && !selected?.cells && selected?.rowCount === totalRows && selected.columnCount === totalColumns);
  }
  clear(): void { this.points = undefined; this.all = false; this.anchor = undefined; this.focus = undefined; this.axis = undefined; this.axisRanges = []; this.axisBase = []; this.axisMoved = false; }

  get bounds(): { firstRow: number; lastRow: number; firstCol: number; lastCol: number } | undefined {
    if (this.points || !this.anchor || !this.focus) return;
    return {
      firstRow: Math.min(this.anchor.row, this.focus.row), lastRow: Math.max(this.anchor.row, this.focus.row),
      firstCol: Math.min(this.anchor.col, this.focus.col), lastCol: Math.max(this.anchor.col, this.focus.col),
    };
  }

  snapshot(totalRows: number, totalColumns: number): { ranges: Range[]; columns: number[]; rowCount: number; columnCount: number; cells?: { row: number; col: number }[] } | undefined {
    if (this.points) {
      if (!this.points.size) return;
      const cells = [...this.points.values()];
      const rows = [...new Set(cells.map(cell => cell.row))].sort((a, b) => a - b);
      const columns = [...new Set(cells.map(cell => cell.col))].sort((a, b) => a - b);
      const ranges = this.merge(rows.map(start => ({ start, count: 1 })));
      const complete = rows.length * columns.length === cells.length;
      return { ranges, columns, rowCount: rows.length, columnCount: columns.length, ...(!complete ? { cells } : {}) };
    }
    const bounds = this.bounds;
    if (!this.all && !bounds && !this.axisRanges.length) return;
    const ranges = this.axis === 'rows' ? this.axisRanges : [{ start: bounds?.firstRow ?? 0, count: bounds ? bounds.lastRow - bounds.firstRow + 1 : totalRows }];
    const columnRanges = this.axis === 'columns' ? this.axisRanges : [{ start: bounds?.firstCol ?? 0, count: bounds ? bounds.lastCol - bounds.firstCol + 1 : totalColumns }];
    const columns = columnRanges.flatMap(range => Array.from({ length: range.count }, (_, index) => range.start + index));
    return { ranges, columns, rowCount: ranges.reduce((sum, range) => sum + range.count, 0), columnCount: columns.length };
  }

  contains(row: number, col: number): boolean {
    if (this.points) return this.points.has(`${row}:${col}`);
    if (this.all) return row >= 0 && col >= 0;
    if (this.axis) return this.axisRanges.some(range => {
      const index = this.axis === 'rows' ? row : col; return index >= range.start && index < range.start + range.count;
    });
    const bounds = this.bounds;
    return Boolean(bounds && row >= bounds.firstRow && row <= bounds.lastRow && col >= bounds.firstCol && col <= bounds.lastCol);
  }
}
