/*
Measure CSV alignment and rectangular selections with the editor font in CSS pixels.
*/
export class CsvTextMetrics {
  private readonly context = document.createElement('canvas').getContext('2d')!;
  readonly tabWidth: number;
  constructor(element: HTMLElement, tabSize: number) {
    const style = getComputedStyle(element);
    this.context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    this.context.fontKerning = 'none';
    this.tabWidth = this.context.measureText(' '.repeat(tabSize)).width;
  }
  width(text: string): number {
    return text.split('\t').reduce((sum, part, index) => sum + this.context.measureText(part).width + (index ? this.tabWidth : 0), 0);
  }
}
