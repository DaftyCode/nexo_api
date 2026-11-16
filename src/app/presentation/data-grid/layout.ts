import { computed, signal } from '@angular/core';
import { columnChars } from '../../domain/db/grid/cells';
import { CellPosition } from '../../domain/db/grid/selection';
import {
  GridView,
  columnWindow,
  rowWindow,
  shownColumns,
  shownRows,
} from '../../domain/db/grid/view';
import { ResultColumn } from '../../domain/db/results';

/** The width of the column of row numbers, in pixels. */
export const ROW_NUMBER = 56;
/** The width of the column of row actions (`⋯`) at the end of every row. */
export const ROW_END = 32;
const PADDING = 24;
/** What a header has besides its name: padding, the type's badge and the menu's ▾. */
const HEADER = 72;

/** What the layout reads from the grid. */
export interface LayoutSource {
  columns: () => readonly ResultColumn[];
  rows: () => readonly unknown[][];
  view: () => GridView;
  filter: () => string;
}

/**
 * Where everything of a grid is: the columns and rows shown, their widths, and which ones
 * are in sight, so only those are drawn. Row number and pinned columns stay at the left.
 */
export class GridLayout {
  readonly scroll = signal({ top: 0, left: 0, height: 320, width: 800 });
  readonly rowHeight = signal(26);
  readonly headerHeight = signal(28);
  readonly charWidth = signal(7.5);

  constructor(private readonly source: LayoutSource) {}

  readonly order = computed(() => shownColumns(this.source.view(), this.source.columns().length));
  readonly shown = computed(() =>
    shownRows(this.source.rows(), { ...this.source.view(), filter: this.source.filter() }),
  );
  /**
   * The widths of the columns the person did not size: each one fitted to its values, and
   * all of them widened alike when they leave room in the grid, so the grid is filled.
   */
  private readonly defaults = computed(() => {
    const fitted = this.source.columns().map((column, index) => this.fitted(column, index));
    const { widths } = this.source.view();
    const shown = this.order();
    const loose = shown.filter((column) => widths[column] === undefined);
    const used = shown.reduce((sum, column) => sum + (widths[column] ?? fitted[column]), 0);
    const room = this.scroll().width - ROW_NUMBER - ROW_END - 2 - used;
    const share = loose.reduce((sum, column) => sum + fitted[column], 0);
    if (room <= 0 || !share) return fitted;
    return fitted.map((width, column) =>
      loose.includes(column) ? Math.floor(width + (room * width) / share) : width,
    );
  });
  readonly pinned = computed(() =>
    this.order().filter((column) => this.source.view().pinned.includes(column)),
  );
  private readonly free = computed(() =>
    this.order().filter((column) => !this.source.view().pinned.includes(column)),
  );
  private readonly freeWidths = computed(() => this.free().map((column) => this.widthOf(column)));
  /** Pinned columns, with where each one sticks. */
  readonly pinnedLeft = computed(() => {
    let left = ROW_NUMBER;
    return this.pinned().map((column) => {
      const at = left;
      left += this.widthOf(column);
      return { column, left: at };
    });
  });
  private readonly pinnedWidth = computed(
    () => ROW_NUMBER + this.pinned().reduce((sum, column) => sum + this.widthOf(column), 0),
  );
  readonly totalWidth = computed(
    () => this.pinnedWidth() + this.freeWidths().reduce((sum, width) => sum + width, 0) + ROW_END,
  );
  readonly totalHeight = computed(
    () => this.headerHeight() + this.shown().length * this.rowHeight(),
  );
  readonly rowsInSight = computed(() => {
    const { top, height } = this.scroll();
    return rowWindow(top, height - this.headerHeight(), this.rowHeight(), this.shown().length);
  });
  private readonly columnsInSight = computed(() => {
    const { left, width } = this.scroll();
    return columnWindow(this.freeWidths(), left, width - this.pinnedWidth());
  });
  /** The rows drawn: their place among those shown, and their index among those loaded. */
  readonly drawnRows = computed(() => {
    const { first, last } = this.rowsInSight();
    const shown = this.shown();
    return Array.from({ length: Math.max(0, last - first) }, (_, k) => ({
      position: first + k,
      row: shown[first + k],
    }));
  });
  /** The free columns drawn, with their place in the order shown. */
  readonly drawnColumns = computed(() => {
    const { first, last } = this.columnsInSight();
    return this.free()
      .slice(first, last)
      .map((column, k) => ({ column, position: this.pinned().length + first + k }));
  });
  /** The width of the free columns left of those drawn. */
  readonly spacer = computed(() => this.columnsInSight().offset);

  widthOf(column: number) {
    return this.source.view().widths[column] ?? this.defaults()[column] ?? 120;
  }
  /** The width a column takes to show its longest loaded value. */
  fitted(column: ResultColumn, index: number) {
    const chars = columnChars(column, this.source.rows(), index);
    const header = Math.round(column.name.length * this.charWidth()) + HEADER;
    return Math.min(Math.max(Math.round(chars * this.charWidth()) + PADDING, header), 360);
  }

  /** Reads the sizes of the drawn rows and of the font, once they are on screen. */
  measure(element: HTMLElement) {
    const row = element.querySelector<HTMLElement>('.grid-row:not(.grid-header)');
    const header = element.querySelector<HTMLElement>('.grid-header');
    if (row?.offsetHeight) this.rowHeight.set(row.offsetHeight);
    if (header?.offsetHeight) this.headerHeight.set(header.offsetHeight);
    const cell = element.querySelector<HTMLElement>('.grid-cell');
    const context = document.createElement('canvas').getContext?.('2d');
    if (cell && context) {
      context.font = getComputedStyle(cell).font;
      const width = context.measureText('0000000000').width / 10;
      if (width > 0) this.charWidth.set(width);
    }
    this.read(element);
  }

  read(element: HTMLElement) {
    this.scroll.set({
      top: element.scrollTop,
      left: element.scrollLeft,
      height: element.clientHeight,
      width: element.clientWidth,
    });
  }

  /** Scrolls so that a cell, by its place among those shown, is in sight. */
  reveal(element: HTMLElement, { row, column }: CellPosition) {
    const top = row * this.rowHeight();
    const room = element.clientHeight - this.headerHeight();
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + this.rowHeight() > element.scrollTop + room)
      element.scrollTop = top + this.rowHeight() - room;
    const free = column - this.pinned().length;
    if (free < 0) return;
    const widths = this.freeWidths();
    const left = widths.slice(0, free).reduce((sum, width) => sum + width, 0);
    const right = left + (widths[free] ?? 0);
    const visible = element.clientWidth - this.pinnedWidth();
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (right > element.scrollLeft + visible) element.scrollLeft = right - visible;
    this.read(element);
  }

  /** How many rows a page is, for PageUp and PageDown. */
  page() {
    const room = this.scroll().height - this.headerHeight();
    return Math.max(1, Math.floor(room / this.rowHeight()) - 1);
  }
}
