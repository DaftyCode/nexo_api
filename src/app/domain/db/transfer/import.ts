/**
 * Rows of a CSV or JSON file into a table, as DBeaver's «Data import»: the file's columns,
 * the kind of each one guessed from a sample (and changeable), each matched to a column of
 * the table by its name, and each cell turned into the value sent bound. The database says
 * what it cannot take, row by row.
 */
import { CsvReader } from '../../mongo-transfer/csv';
import { JsonDocumentsReader } from '../../mongo-transfer/json';
import { BOM } from './export';

export type ImportKind =
  'integer' | 'decimal' | 'float' | 'boolean' | 'date' | 'timestamp' | 'json' | 'text';

export const IMPORT_KINDS: readonly ImportKind[] = [
  'integer',
  'decimal',
  'float',
  'boolean',
  'date',
  'timestamp',
  'json',
  'text',
];

/** A column of the file: where it goes (empty: skipped) and how its cells are read. */
export interface FileColumn {
  name: string;
  target: string;
  kind: ImportKind;
}

/** What is done to every cell before it is sent. */
export interface CellTransform {
  trim: boolean;
  /** An empty cell is `NULL` instead of an empty text. */
  emptyAsNull: boolean;
}

const INTEGER = /^[-+]?\d+$/;
const DECIMAL = /^[-+]?(\d+\.\d*|\.\d+|\d+)$/;
const FLOAT = /^[-+]?(\d+\.?\d*|\.\d+)[eE][-+]?\d+$/;
const BOOLEAN = /^(true|false)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The kind of a cell, as it is written. */
function kindOf(value: unknown): ImportKind | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'json';
  const text = String(value).trim();
  if (INTEGER.test(text)) return 'integer';
  if (DECIMAL.test(text)) return 'decimal';
  if (FLOAT.test(text)) return 'float';
  if (BOOLEAN.test(text)) return 'boolean';
  if (DATE.test(text)) return 'date';
  if (TIMESTAMP.test(text)) return 'timestamp';
  return 'text';
}

/** The narrowest kind every sample fits: integers widen to decimals, the rest to text. */
export function inferKind(samples: readonly unknown[]): ImportKind {
  let found: ImportKind | undefined;
  for (const sample of samples) {
    const kind = kindOf(sample);
    if (!kind || kind === found) continue;
    if (!found) found = kind;
    else if (
      (found === 'integer' && kind === 'decimal') ||
      (found === 'decimal' && kind === 'integer')
    )
      found = 'decimal';
    else if (
      (found === 'date' && kind === 'timestamp') ||
      (found === 'timestamp' && kind === 'date')
    )
      found = 'timestamp';
    else return 'text';
  }
  return found ?? 'text';
}

const plain = (name: string) => name.toLowerCase().replace(/[\s_-]/g, '');

/** The file's columns, each matched by name to a column of the table (or skipped). */
export function matchColumns(
  names: readonly string[],
  samples: readonly (readonly unknown[])[],
  table: readonly string[],
): FileColumn[] {
  return names.map((name, at) => ({
    name,
    target: table.find((column) => plain(column) === plain(name)) ?? '',
    kind: inferKind(samples.map((row) => row[at])),
  }));
}

/** A cell as the value sent: numbers and booleans as such, `NULL`, or its text. */
export function cellValue(raw: unknown, kind: ImportKind, transform: CellTransform): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return JSON.stringify(raw);
  let text = String(raw);
  if (transform.trim) text = text.trim();
  if (text === '' && transform.emptyAsNull) return null;
  switch (kind) {
    case 'integer': {
      const number = Number(text);
      return INTEGER.test(text) && Number.isSafeInteger(number) ? number : text;
    }
    case 'float': {
      const number = Number(text);
      return text !== '' && Number.isFinite(number) ? number : text;
    }
    case 'boolean':
      return /^(true|1|yes)$/i.test(text) ? true : /^(false|0|no)$/i.test(text) ? false : text;
    default:
      // Decimals keep every digit, and the database reads dates and JSON from their text.
      return typeof raw === 'number' || typeof raw === 'boolean' ? raw : text;
  }
}

/** The row sent for a row of the file: the cells of the columns that go somewhere. */
export function rowValues(
  row: readonly unknown[],
  columns: readonly FileColumn[],
  transform: CellTransform,
): unknown[] {
  return columns
    .map((column, at) => (column.target ? cellValue(row[at], column.kind, transform) : undefined))
    .filter((_, at) => !!columns[at].target);
}

/** The JSON objects of a file as rows, by the keys first seen. */
export function objectRows(
  objects: readonly Record<string, unknown>[],
  keys: string[],
): unknown[][] {
  for (const object of objects)
    for (const key of Object.keys(object)) if (!keys.includes(key)) keys.push(key);
  return objects.map((object) => keys.map((key) => object[key] ?? null));
}

/** The type a kind is created with, for `db.convert`: the driver's words for its values. */
export function kindColumn(column: FileColumn): { name: string; kind: string; typeName: string } {
  const kinds: Record<ImportKind, [string, string]> = {
    integer: ['integer', 'bigint'],
    decimal: ['decimal', 'numeric(38,10)'],
    float: ['float', 'double'],
    boolean: ['boolean', 'boolean'],
    date: ['date', 'date'],
    timestamp: ['timestamp', 'timestamp'],
    json: ['json', 'json'],
    text: ['text', 'text'],
  };
  const [kind, typeName] = kinds[column.kind];
  return { name: column.target || column.name, kind, typeName };
}

/** Rows of a file read for its preview, and sampled to guess the kinds of its columns. */
export const PREVIEW_ROWS = 20;

/** The first rows of a file and the names of its columns (`column1`… without a header). */
export function previewRows(
  text: string,
  format: 'csv' | 'json',
  separator: string,
  header: boolean,
): { names: string[]; rows: unknown[][] } {
  const clean = text.startsWith(BOM) ? text.slice(1) : text;
  if (format === 'json') {
    const names: string[] = [];
    const objects = new JsonDocumentsReader()
      .push(clean)
      .flatMap((each) => ('document' in each ? [each.document] : []));
    return { names, rows: objectRows(objects.slice(0, PREVIEW_ROWS), names) };
  }
  const read = new CsvReader(separator).push(clean).slice(0, PREVIEW_ROWS + 1);
  const names = header ? (read.shift() ?? []) : (read[0] ?? []).map((_, at) => `column${at + 1}`);
  return { names, rows: read };
}

/** The kind a column of the table takes its values in, from the kind its driver gives. */
export function kindOfColumn(kind: string): ImportKind | undefined {
  switch (kind) {
    case 'integer':
    case 'decimal':
    case 'float':
    case 'boolean':
    case 'date':
    case 'json':
    case 'text':
      return kind;
    case 'timestamp':
    case 'timestamptz':
      return 'timestamp';
    default:
      return undefined;
  }
}
