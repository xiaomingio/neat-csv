/*
Calculate virtual row positions with a sparse balanced height index and lazy content sizing.
*/
type HeightNode = { row: number; value: number; sum: number; depth: number; left?: HeightNode; right?: HeightNode };

export class RowLayout {
  private root?: HeightNode;
  private readonly measured = new Set<number>();
  autoFit = false;
  readonly defaultHeight = 30;

  clear(): void { this.root = undefined; this.measured.clear(); this.autoFit = false; }
  fitAll(): void { this.clear(); this.autoFit = true; }
  resetMeasurements(): void { if (this.autoFit) this.fitAll(); }
  needsMeasurement(row: number): boolean { return this.autoFit && !this.measured.has(row); }
  height(row: number): number {
    let node = this.root;
    while (node) { if (node.row === row) return node.value + this.defaultHeight; node = row < node.row ? node.left : node.right; }
    return this.defaultHeight;
  }
  set(row: number, height: number): void {
    this.measured.add(row);
    const value = Math.max(this.defaultHeight, Math.min(600, Math.round(height))) - this.defaultHeight;
    if (value || this.height(row) !== this.defaultHeight) this.root = this.insert(this.root, row, value);
  }
  offset(row: number): number {
    let node = this.root, sum = row * this.defaultHeight;
    while (node) {
      if (node.row < row) { sum += (node.left?.sum ?? 0) + node.value; node = node.right; }
      else node = node.left;
    }
    return sum;
  }
  rowAt(offset: number, total: number): number {
    let low = 0, high = total;
    while (low < high) { const mid = (low + high) >>> 1; if (this.offset(mid + 1) <= offset) low = mid + 1; else high = mid; }
    return Math.min(Math.max(0, total - 1), low);
  }
  private update(node: HeightNode): HeightNode {
    node.sum = node.value + (node.left?.sum ?? 0) + (node.right?.sum ?? 0);
    node.depth = 1 + Math.max(node.left?.depth ?? 0, node.right?.depth ?? 0);
    return node;
  }
  private rotate(node: HeightNode, left: boolean): HeightNode {
    const next = (left ? node.right : node.left)!;
    if (left) { node.right = next.left; next.left = this.update(node); }
    else { node.left = next.right; next.right = this.update(node); }
    return this.update(next);
  }
  private insert(node: HeightNode | undefined, row: number, value: number): HeightNode {
    if (!node) return { row, value, sum: value, depth: 1 };
    if (row < node.row) node.left = this.insert(node.left, row, value);
    else if (row > node.row) node.right = this.insert(node.right, row, value);
    else node.value = value;
    this.update(node);
    const balance = (node.left?.depth ?? 0) - (node.right?.depth ?? 0);
    if (balance > 1) {
      if ((node.left!.left?.depth ?? 0) < (node.left!.right?.depth ?? 0)) node.left = this.rotate(node.left!, true);
      return this.rotate(node, false);
    }
    if (balance < -1) {
      if ((node.right!.right?.depth ?? 0) < (node.right!.left?.depth ?? 0)) node.right = this.rotate(node.right!, false);
      return this.rotate(node, true);
    }
    return node;
  }
}
