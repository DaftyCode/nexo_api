/**
 * Rows edited in the data grid before they are saved, as DBeaver keeps them: changed cells of
 * the rows read, new rows after them and deleted rows, each step undoable; whether a result
 * can be edited at all (its columns from one table, with a key that names each row); and the
 * changes a save sends (`db.rows.write`).
 */
import { ResultColumn } from './results';

/** The value of a cell left to its column's default. */
export const DEFAULT_VALUE: Readonly<{ $default: true }> = { $default: true };
export const isDefault = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (value as { $default?: unknown }).$default === true;

/** The table a result's rows are written to, and the columns that name each row. */
export interface EditTarget {
  schema?: string;
  table: string;
  /** Indexes of the key columns in the result. */
  key: readonly number[];
}
export type Editability =
  { target: EditTarget; reason?: undefined } | { reason: string; target?: undefined };

/** The name of a result column in its table. */
export const columnName = (column: ResultColumn) => column.origin?.column ?? column.name;

/**
 * Whether the rows of a result can be edited: never on a read-only connection; only when every
 * column comes from one table and the key that names each row (its primary key, or the
 * virtual key chosen for it) is among them.
 */
export function editability(
  columns: readonly ResultColumn[],
  options: { readOnly: boolean; virtualKey?: readonly string[] },
): Editability {
  if (options.readOnly) return { reason: 'db.edit.readOnly' };
  const first = columns[0]?.origin;
  if (!first?.table) return { reason: 'db.edit.notOneTable' };
  const sameTable = columns.every(
    (column) => column.origin?.table === first.table && column.origin?.schema === first.schema,
  );
  if (!sameTable) return { reason: 'db.edit.notOneTable' };
  const chosen = options.virtualKey ?? [];
  const key = columns
    .map((column, index) =>
      (chosen.length ? chosen.includes(columnName(column)) : !!column.key) ? index : -1,
    )
    .filter((index) => index >= 0);
  if (!key.length || (chosen.length && key.length !== chosen.length))
    return { reason: 'db.edit.noKey' };
  return {
    target: { ...(first.schema ? { schema: first.schema } : {}), table: first.table, key },
  };
}

/** What is pending: changed cells of the rows read, new rows, and deleted ones. */
export interface RowEdits {
  /** By row read, then by column. */
  updates: ReadonlyMap<number, ReadonlyMap<number, unknown>>;
  /** Whole rows, in the order of the columns; `DEFAULT_VALUE` where nothing was given. */
  inserts: readonly (readonly unknown[])[];
  deletes: ReadonlySet<number>;
}
export interface EditHistory {
  now: RowEdits;
  /** Earlier states, the last one first undone. */
  past: readonly RowEdits[];
}
const UNDO_STEPS = 200;

export const noEdits = (): EditHistory => ({
  now: { updates: new Map(), inserts: [], deletes: new Set() },
  past: [],
});
const step = (history: EditHistory, now: RowEdits): EditHistory => ({
  now,
  past: [history.now, ...history.past].slice(0, UNDO_STEPS),
});

/** How many rows a save would write. */
export function changeCount(edits: RowEdits): number {
  const updated = [...edits.updates.keys()].filter((row) => !edits.deletes.has(row)).length;
  return updated + edits.inserts.length + edits.deletes.size;
}

/** A cell set to `value`: of a row read (`row < loaded`) or of a new one after them. */
export function setCell(
  history: EditHistory,
  loaded: number,
  row: number,
  column: number,
  value: unknown,
): EditHistory {
  const { now } = history;
  if (row >= loaded) {
    const inserts = now.inserts.map((values, index) =>
      index === row - loaded ? values.map((old, at) => (at === column ? value : old)) : values,
    );
    return step(history, { ...now, inserts });
  }
  if (now.deletes.has(row)) return history;
  const updates = new Map(now.updates);
  updates.set(row, new Map(updates.get(row)).set(column, value));
  return step(history, { ...now, updates });
}

/** A new row, every cell left to its default. */
export function addRow(history: EditHistory, width: number): EditHistory {
  const row = Array.from({ length: width }, () => DEFAULT_VALUE);
  return step(history, { ...history.now, inserts: [...history.now.inserts, row] });
}

/** New rows copying some, their key left to its default (an identity gives the next one). */
export function duplicateRows(
  history: EditHistory,
  shown: readonly (readonly unknown[])[],
  rows: readonly number[],
  key: readonly number[],
): EditHistory {
  const copies = rows
    .filter((row) => shown[row])
    .map((row) =>
      shown[row].map((value, column) => (key.includes(column) ? DEFAULT_VALUE : value)),
    );
  return step(history, { ...history.now, inserts: [...history.now.inserts, ...copies] });
}

/** Rows deleted: rows read are marked; new ones are simply dropped. */
export function deleteRows(history: EditHistory, loaded: number, rows: readonly number[]) {
  const { now } = history;
  const deletes = new Set(now.deletes);
  for (const row of rows) if (row < loaded) deletes.add(row);
  const dropped = new Set(rows.filter((row) => row >= loaded).map((row) => row - loaded));
  const inserts = now.inserts.filter((_, index) => !dropped.has(index));
  return step(history, { ...now, deletes, inserts });
}

export function undo(history: EditHistory): EditHistory {
  const [last, ...past] = history.past;
  return last ? { now: last, past } : history;
}

/** The rows to show: those read with their changes, then the new ones. */
export function shownRows(rows: readonly (readonly unknown[])[], edits: RowEdits): unknown[][] {
  const read = rows.map((row, index) => {
    const changed = edits.updates.get(index);
    return changed
      ? row.map((value, column) => (changed.has(column) ? changed.get(column) : value))
      : [...row];
  });
  return [...read, ...edits.inserts.map((row) => [...row])];
}

/** How a row shows what is pending in it. */
export interface RowMark {
  kind: 'changed' | 'new' | 'deleted';
  cells: ReadonlySet<number>;
}
export function marks(loaded: number, edits: RowEdits): ReadonlyMap<number, RowMark> {
  const found = new Map<number, RowMark>();
  for (const [row, cells] of edits.updates)
    found.set(row, { kind: 'changed', cells: new Set(cells.keys()) });
  for (const row of edits.deletes) found.set(row, { kind: 'deleted', cells: new Set() });
  edits.inserts.forEach((_, index) => found.set(loaded + index, { kind: 'new', cells: new Set() }));
  return found;
}

/** A column's value in a change, as `db.rows.write` takes it. */
export interface ChangedCell {
  column: string;
  value: unknown;
  default?: true;
}
export type RowChange =
  | { kind: 'insert'; values: ChangedCell[] }
  | { kind: 'update'; key: ChangedCell[]; values: ChangedCell[]; original: ChangedCell[] }
  | { kind: 'delete'; key: ChangedCell[]; original: ChangedCell[] };

/** A cut value cannot stand for what the server has: it is never sent as an original. */
const whole = (value: unknown) =>
  !(typeof value === 'object' && value !== null && (value as { truncated?: unknown }).truncated);

/** The changes a save sends, in order: updates, new rows, then deleted rows. */
export function rowChanges(
  columns: readonly ResultColumn[],
  rows: readonly (readonly unknown[])[],
  edits: RowEdits,
  target: EditTarget,
): RowChange[] {
  const cell = (column: number, value: unknown): ChangedCell =>
    isDefault(value)
      ? { column: columnName(columns[column]), value: null, default: true }
      : { column: columnName(columns[column]), value: value ?? null };
  const key = (row: number) => target.key.map((column) => cell(column, rows[row][column]));
  const original = (row: number, only?: ReadonlySet<number>) =>
    columns
      .map((_, column) => column)
      .filter((column) => (!only || only.has(column)) && whole(rows[row][column]))
      .map((column) => cell(column, rows[row][column]));
  const updates: RowChange[] = [...edits.updates]
    .filter(([row]) => !edits.deletes.has(row))
    .map(([row, changed]) => ({
      kind: 'update',
      key: key(row),
      values: [...changed].map(([column, value]) => cell(column, value)),
      original: original(row, new Set(changed.keys())),
    }));
  const inserts: RowChange[] = edits.inserts.map((values) => ({
    kind: 'insert',
    values: values.map((value, column) => cell(column, value)),
  }));
  const deletes: RowChange[] = [...edits.deletes].map((row) => ({
    kind: 'delete',
    key: key(row),
    original: original(row),
  }));
  return [...updates, ...inserts, ...deletes];
}
