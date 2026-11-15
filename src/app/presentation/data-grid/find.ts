import { computed, signal } from '@angular/core';
import { CellPosition } from '../../domain/db/grid/selection';
import { cellText } from '../../domain/db/results';

/** The most cells marked as found. */
const MOST = 10_000;

/** «Find in results» (Ctrl+F): the cells shown that hold a text, and going from one to the next. */
export class GridFind {
  readonly open = signal(false);

  constructor(
    private readonly text: () => string,
    private readonly rows: () => readonly unknown[][],
    private readonly shown: () => readonly number[],
    private readonly order: () => readonly number[],
  ) {}

  readonly matches = computed(() => {
    const wanted = this.text().trim().toLowerCase();
    if (!wanted || !this.open()) return [];
    const found: CellPosition[] = [];
    const rows = this.rows();
    const order = this.order();
    for (const [row, index] of this.shown().entries())
      for (const [column, at] of order.entries()) {
        if (found.length >= MOST) return found;
        if (cellText(rows[index][at]).toLowerCase().includes(wanted)) found.push({ row, column });
      }
    return found;
  });
  private readonly keys = computed(
    () => new Set(this.matches().map((match) => `${match.row}:${match.column}`)),
  );

  has(row: number, column: number) {
    return this.keys().has(`${row}:${column}`);
  }

  /** The found cell after (or before) a position, going round at the ends. */
  next(from: CellPosition, back = false): CellPosition | undefined {
    const matches = this.matches();
    if (!matches.length) return undefined;
    const after = (match: CellPosition) =>
      match.row > from.row || (match.row === from.row && match.column > from.column);
    const before = (match: CellPosition) =>
      match.row < from.row || (match.row === from.row && match.column < from.column);
    return back
      ? ([...matches].reverse().find(before) ?? matches.at(-1))
      : (matches.find(after) ?? matches[0]);
  }
}
