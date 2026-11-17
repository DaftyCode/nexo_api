/**
 * The result tabs under a SQL editor, as SQuirreL keeps them: each query that returns rows
 * leaves its own tab, numbered, until there are more than the most kept; then the oldest
 * one that is not pinned closes. A pinned tab is never closed nor reused by itself.
 */
import type { ExplainPlan } from './plan';

/** A column of a result, as the driver describes it. */
export interface ResultColumn {
  name: string;
  typeName: string;
  kind: string;
  nullable?: boolean;
  key?: boolean;
  origin?: { schema?: string; table?: string; column?: string };
}

/** What `db.execute` answers. */
export interface ExecuteAnswer {
  columns: ResultColumn[];
  rows: unknown[][];
  cursor?: string | null;
  affected?: number | null;
  notices?: { severity: string; message: string }[];
  elapsedMs: number;
  /** The results after the first one of a batch or procedure, read whole up to a limit. */
  results?: FurtherResult[];
}

/** A further result of a batch: its rows, and whether there were more than these. */
export interface FurtherResult {
  columns: ResultColumn[];
  rows: unknown[][];
  truncated?: boolean;
}

export interface ResultTab {
  id: string;
  /** The order of the query in the editor, from 1, for its title. */
  order: number;
  sql: string;
  pinned: boolean;
  columns: ResultColumn[];
  rows: unknown[][];
  /** The cursor that reads the rest, while there is more. */
  cursor?: string;
  /** The driver closed its cursor (too many open): the rest needs running it again. */
  lost?: boolean;
  startedAt: number;
  executeMs: number;
  fetchMs: number;
  /** A plan instead of rows: the statement was explained (DB-16). */
  plan?: ExplainPlan;
}

/** The most result tabs kept by default, as SQuirreL. */
export const DEFAULT_MAX_RESULTS = 15;

/** The title of a result tab: its number and the start of its statement. */
export function resultTitle(tab: Pick<ResultTab, 'order' | 'sql'>): string {
  const text = tab.sql.replace(/\s+/g, ' ').trim();
  return `${tab.order} · ${text.length > 32 ? `${text.slice(0, 32)}…` : text}`;
}

/**
 * Adds a result. With `reuse`, it replaces the last tab that is not pinned instead of
 * opening another. Returns the tabs and the ones that closed, whose cursors must be closed.
 */
export function addResult(
  tabs: readonly ResultTab[],
  tab: ResultTab,
  options: { reuse: boolean; max: number },
): { tabs: ResultTab[]; closed: ResultTab[] } {
  const closed: ResultTab[] = [];
  let next = [...tabs];
  if (options.reuse) {
    const last = [...next].reverse().find((other) => !other.pinned);
    if (last) {
      closed.push(last);
      next = next.map((other) => (other === last ? tab : other));
    } else next.push(tab);
  } else next.push(tab);
  const max = Math.max(1, options.max);
  while (next.length > max) {
    const oldest = next.find((other) => !other.pinned && other.id !== tab.id);
    if (!oldest) break;
    closed.push(oldest);
    next = next.filter((other) => other !== oldest);
  }
  return { tabs: next, closed };
}

/** Replaces a tab with a new run of its statement, keeping its place, number and pin. */
export function rerunResult(tabs: readonly ResultTab[], id: string, fresh: ResultTab) {
  return tabs.map((tab) =>
    tab.id === id ? { ...fresh, id, order: tab.order, pinned: tab.pinned } : tab,
  );
}

/** The tabs left after closing those that `close` picks, and the ones closed. */
export function closeResults(tabs: readonly ResultTab[], close: (tab: ResultTab) => boolean) {
  return { tabs: tabs.filter((tab) => !close(tab)), closed: tabs.filter(close) };
}

/** A value of a result as text: `NULL`, numbers and texts as they are, typed values by text. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(cellText).join(', ')}]`;
  const typed = value as { $t?: unknown; v?: unknown; truncated?: boolean };
  if (typeof typed.$t === 'string') {
    const text = Array.isArray(typed.v) ? cellText(typed.v) : String(typed.v ?? '');
    return typed.truncated ? `${text}…` : text;
  }
  return JSON.stringify(value);
}

/** Whether a value is SQL `NULL`. */
export const isNull = (value: unknown) => value === null || value === undefined;

/** What the «Summary» tab says of a column over the rows read. */
export interface ColumnSummary {
  name: string;
  distinct: number;
  nulls: number;
  min?: string;
  max?: string;
}

/** Numbers compare as numbers; everything else as its text. */
function compare(a: unknown, b: unknown): number {
  const number = (value: unknown) =>
    typeof value === 'number'
      ? value
      : typeof (value as { v?: unknown })?.v === 'string' &&
          ['integer', 'decimal', 'float'].includes(String((value as { $t?: unknown }).$t))
        ? Number((value as { v: string }).v)
        : NaN;
  const [x, y] = [number(a), number(b)];
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return cellText(a).localeCompare(cellText(b));
}

export function summarize(columns: readonly ResultColumn[], rows: readonly unknown[][]) {
  return columns.map((column, index): ColumnSummary => {
    const values = rows.map((row) => row[index]);
    const present = values.filter((value) => !isNull(value));
    const sorted = [...present].sort(compare);
    return {
      name: column.name,
      distinct: new Set(present.map(cellText)).size,
      nulls: values.length - present.length,
      ...(sorted.length ? { min: cellText(sorted[0]), max: cellText(sorted.at(-1)) } : {}),
    };
  });
}
