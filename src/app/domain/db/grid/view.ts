/**
 * What the person did to a grid's columns and rows, kept per result tab: column order,
 * widths, hidden and pinned columns, and the order and filter over the rows loaded. And
 * which rows and columns are in sight, so only those are drawn.
 */
import { cellText } from '../results';

export interface GridSort {
  column: number;
  descending: boolean;
}

export interface GridView {
  /** Column indexes in the order shown; empty for the result's order. */
  order: number[];
  /** Widths in pixels, by column index. */
  widths: Record<number, number>;
  hidden: number[];
  /** Columns fixed at the left, by index. */
  pinned: number[];
  sort?: GridSort;
  /** Rows whose text holds this, over what was loaded. */
  filter: string;
}

export function emptyView(): GridView {
  return { order: [], widths: {}, hidden: [], pinned: [], filter: '' };
}

/** The columns shown, in order: pinned first, then the rest; hidden ones left out. */
export function shownColumns(view: GridView, count: number): number[] {
  const all = Array.from({ length: count }, (_, index) => index);
  const order = view.order.length === count ? view.order : all;
  const shown = order.filter((index) => !view.hidden.includes(index));
  return [
    ...shown.filter((index) => view.pinned.includes(index)),
    ...shown.filter((index) => !view.pinned.includes(index)),
  ];
}

/** One collator for every comparison: far quicker than `localeCompare` on each pair. */
const collator = new Intl.Collator(undefined, { numeric: true });

/** What a value is ordered by: `NULL`, a number, or its text. */
type SortKey = { kind: 0; value: number } | { kind: 1; value: string } | { kind: 2 };

function sortKey(value: unknown): SortKey {
  if (value === null || value === undefined) return { kind: 2 };
  if (typeof value === 'number') return { kind: 0, value };
  const typed = value as { $t?: unknown; v?: unknown };
  if (['integer', 'decimal', 'float'].includes(String(typed?.$t))) {
    const number = Number(typed.v);
    if (!Number.isNaN(number)) return { kind: 0, value: number };
  }
  return { kind: 1, value: cellText(value) };
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.kind === 2 || b.kind === 2) return a.kind === b.kind ? 0 : a.kind === 2 ? 1 : -1;
  if (a.kind === 0 && b.kind === 0) return a.value - b.value;
  return collator.compare(String(a.value), String(b.value));
}

/** Numbers compare as numbers, `NULL` last, everything else by its text. */
export function compareValues(a: unknown, b: unknown): number {
  return compareKeys(sortKey(a), sortKey(b));
}

/** The rows shown, as indexes of the rows loaded: filtered, then sorted. */
export function shownRows(rows: readonly unknown[][], view: GridView): number[] {
  const wanted = view.filter.trim().toLowerCase();
  let indexes = rows.map((_, index) => index);
  if (wanted)
    indexes = indexes.filter((index) =>
      rows[index].some((value) => cellText(value).toLowerCase().includes(wanted)),
    );
  const sort = view.sort;
  if (!sort) return indexes;
  // Each value's key is worked out once, not on every comparison.
  const direction = sort.descending ? -1 : 1;
  return indexes
    .map((index) => ({ index, key: sortKey(rows[index][sort.column]) }))
    .sort((a, b) => direction * compareKeys(a.key, b.key) || a.index - b.index)
    .map((entry) => entry.index);
}

/** The next order of a column clicked in its header: ascending, descending, none. */
export function nextSort(current: GridSort | undefined, column: number): GridSort | undefined {
  if (current?.column !== column) return { column, descending: false };
  return current.descending ? undefined : { column, descending: true };
}

/** Moves a column before or after another in the order shown. */
export function moveColumn(
  view: GridView,
  count: number,
  from: number,
  to: number,
  after: boolean,
) {
  const order = (
    view.order.length === count ? view.order : shownColumns(emptyView(), count)
  ).filter((index) => index !== from);
  const at = order.indexOf(to) + (after ? 1 : 0);
  order.splice(at, 0, from);
  return { ...view, order };
}

/** The first and last item in sight of a list of equal heights, with a few around them. */
export function rowWindow(
  scroll: number,
  viewport: number,
  height: number,
  count: number,
  extra = 6,
) {
  const first = Math.max(0, Math.floor(scroll / height) - extra);
  const last = Math.min(count, Math.ceil((scroll + viewport) / height) + extra);
  return { first, last };
}

/**
 * The columns in sight, given their widths in order and where the view is scrolled
 * horizontally; with the offset of the first one, to place it.
 */
export function columnWindow(
  widths: readonly number[],
  scroll: number,
  viewport: number,
  extra = 2,
) {
  let left = 0;
  let first = 0;
  while (first < widths.length && left + widths[first] < scroll) left += widths[first++];
  let last = first;
  let right = left;
  while (last < widths.length && right < scroll + viewport) right += widths[last++];
  const from = Math.max(0, first - extra);
  const offset = left - widths.slice(from, first).reduce((sum, width) => sum + width, 0);
  return { first: from, last: Math.min(widths.length, last + extra), offset };
}
