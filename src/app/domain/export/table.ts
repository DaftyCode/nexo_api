/**
 * Tables to export as CSV or Excel (B-06): the records of a JSON response (an array of
 * objects, or the one array of objects an object holds, as `{"data": [...]}`) and the
 * requests of a collection run. Embedded objects become columns with dotted names
 * (`address.city`); arrays stay in their cell as JSON.
 */
import { RunReport } from '../reports';
import { BOM } from './bom';

export type TableFormat = 'csv' | 'xlsx';
export const TABLE_FORMATS: readonly TableFormat[] = ['csv', 'xlsx'];
/** CSV separators: a comma, a semicolon (what Excel expects where the decimal mark is a comma) or a tab. */
export const CSV_SEPARATORS = [',', ';', '\t'] as const;
/** Columns of a table, at most; the rest of the fields are left out. */
export const MAX_TABLE_COLUMNS = 1000;

export type JsonRecord = Record<string, unknown>;

export interface Table {
  columns: string[];
  rows: unknown[][];
}

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The records of a JSON value: its items when it is an array of objects, or those of the
 * only field of an object that is one; with the name of that field.
 */
export function recordsOf(value: unknown): { records: JsonRecord[]; name: string } | undefined {
  const records = (list: unknown) =>
    Array.isArray(list) && list.length > 0 && list.every(isRecord) ? list : undefined;
  const top = records(value);
  if (top) return { records: top, name: '' };
  if (!isRecord(value)) return undefined;
  const lists = Object.entries(value).filter(([, inner]) => records(inner));
  return lists.length === 1
    ? { records: lists[0][1] as JsonRecord[], name: lists[0][0] }
    : undefined;
}

/** The records of a response body, when it is JSON with some. */
export function bodyRecords(body: string): { records: JsonRecord[]; name: string } | undefined {
  try {
    return recordsOf(JSON.parse(body));
  } catch {
    return undefined;
  }
}

/** Records as a table: a column per field, embedded objects flattened with dots. */
export function flatten(records: readonly unknown[]): Table & { cut: boolean } {
  const columns = new Map<string, number>();
  let cut = false;
  const cells = records.map((record) => {
    const row = new Map<number, unknown>();
    const visit = (value: JsonRecord, prefix: string) => {
      for (const [key, inner] of Object.entries(value)) {
        const name = prefix + key;
        if (isRecord(inner) && Object.keys(inner).length) {
          visit(inner, `${name}.`);
          continue;
        }
        let at = columns.get(name);
        if (at === undefined) {
          if (columns.size >= MAX_TABLE_COLUMNS) {
            cut = true;
            continue;
          }
          at = columns.size;
          columns.set(name, at);
        }
        row.set(at, inner !== null && typeof inner === 'object' ? JSON.stringify(inner) : inner);
      }
    };
    if (isRecord(record)) visit(record, '');
    return row;
  });
  const width = columns.size;
  return {
    columns: [...columns.keys()],
    rows: cells.map((row) => Array.from({ length: width }, (_, at) => row.get(at) ?? null)),
    cut,
  };
}

/** A collection run as records: one per request and iteration, with its tests. */
export function runRecords(report: RunReport): JsonRecord[] {
  return report.requests.map((request) => {
    const counted = request.assertions.filter((assertion) => !assertion.skipped);
    return {
      iteration: request.iteration + 1,
      request: request.name,
      method: request.method,
      url: request.url,
      status: request.status,
      statusText: request.statusText,
      timeMs: request.time,
      result: request.failed ? 'failed' : 'passed',
      passed: counted.filter((assertion) => assertion.passed).length,
      failed: counted.filter((assertion) => !assertion.passed).length,
      skipped: request.assertions.length - counted.length,
      failures: request.assertions
        .filter((assertion) => !assertion.passed && !assertion.skipped)
        .map((assertion) =>
          assertion.error ? `${assertion.name}: ${assertion.error}` : assertion.name,
        )
        .join('\n'),
      error: request.error ?? '',
    };
  });
}

function csvCell(value: unknown, separator: string): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.includes(separator) || /["\r\n]|^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

/**
 * A table as CSV, with a header. The byte order mark lets Excel read it as UTF-8; a cell
 * that starts like a formula (`=`, `+`, `-`, `@`) is written as text so a spreadsheet does
 * not run it.
 */
export function csvText(table: Table, separator = ',', bom = true): string {
  const cell = (value: unknown) => {
    const text = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return csvCell(text, separator);
  };
  const line = (cells: readonly unknown[]) => cells.map(cell).join(separator);
  return (
    (bom ? BOM : '') +
    [line(table.columns), ...table.rows.map(line)].map((row) => row + '\r\n').join('')
  );
}
