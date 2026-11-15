import { ModelSignal } from '@angular/core';
import { GridView, moveColumn, nextSort } from '../../domain/db/grid/view';

/** The narrowest and widest a column gets, in pixels. */
export const COLUMN = { min: 48, max: 1200 };

/**
 * What can be done to a grid's columns, over its view: resize, fit, sort, hide, pin, move.
 * Every change makes a new view, kept per result tab.
 */
export class GridColumns {
  constructor(
    private readonly view: ModelSignal<GridView>,
    private readonly count: () => number,
    private readonly fitted: (column: number) => number,
  ) {}

  private change(update: (view: GridView) => GridView) {
    this.view.update(update);
  }

  resize(column: number, width: number) {
    const clamped = Math.round(Math.min(Math.max(width, COLUMN.min), COLUMN.max));
    this.change((view) => ({ ...view, widths: { ...view.widths, [column]: clamped } }));
  }
  /** The width of its longest loaded value. */
  fit(column: number) {
    this.resize(column, this.fitted(column));
  }
  sort(column: number) {
    this.change((view) => ({ ...view, sort: nextSort(view.sort, column) }));
  }
  sortAs(column: number, descending: boolean | undefined) {
    this.change((view) => ({
      ...view,
      sort: descending === undefined ? undefined : { column, descending },
    }));
  }
  hide(column: number) {
    this.change((view) => ({ ...view, hidden: [...new Set([...view.hidden, column])] }));
  }
  showAll() {
    this.change((view) => ({ ...view, hidden: [] }));
  }
  togglePin(column: number) {
    this.change((view) => ({
      ...view,
      pinned: view.pinned.includes(column)
        ? view.pinned.filter((other) => other !== column)
        : [...view.pinned, column],
    }));
  }
  /** Moves a column before or after another one. */
  move(column: number, over: number, after: boolean) {
    if (column === over) return;
    this.change((view) => moveColumn(view, this.count(), column, over, after));
  }
  /** Runs an entry of the column menu; false when it is not one of the columns. */
  run(choice: string, column: number, shown: readonly number[], width: number): boolean {
    const actions: Record<string, () => void> = {
      ascending: () => this.sortAs(column, false),
      descending: () => this.sortAs(column, true),
      unsorted: () => this.sortAs(column, undefined),
      fit: () => this.fit(column),
      wider: () => this.resize(column, width + 32),
      narrower: () => this.resize(column, width - 32),
      hide: () => this.hide(column),
      'show-all': () => this.showAll(),
      pin: () => this.togglePin(column),
      left: () => this.shift(column, shown, -1),
      right: () => this.shift(column, shown, 1),
    };
    actions[choice]?.();
    return !!actions[choice];
  }

  /** Moves a column one place, by the keyboard. */
  shift(column: number, shown: readonly number[], step: -1 | 1) {
    const at = shown.indexOf(column);
    const other = shown[at + step];
    if (other !== undefined) this.move(column, other, step > 0);
  }
}
