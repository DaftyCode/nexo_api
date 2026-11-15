/**
 * Copying cells of a grid, as DBeaver's «Advanced copy»: tab-separated text (with or
 * without headers), JSON, CSV, Markdown, an `IN (…)` list and `INSERT` statements written
 * for the engine (its quotes, its literals).
 */
import { ResultColumn, cellText, isNull } from '../results';
import { QuoteStyle, quoteName } from '../tree';
import { base64Bytes, classOf } from './cells';

export type CopyFormat = 'text' | 'text-headers' | 'json' | 'csv' | 'markdown' | 'in' | 'insert';

/** What is copied: the columns and the rows of the selection, in the order shown. */
export interface CopiedCells {
  columns: readonly ResultColumn[];
  rows: readonly (readonly unknown[])[];
}

/** How the engine writes values and names in SQL, for `IN` and `INSERT`. */
export interface SqlStyle extends QuoteStyle {
  /** The dialect's name, as the driver says it (`postgresql`, `tsql`…). */
  name: string;
}

const tabbed = (text: string) => text.replace(/[\t\n\r]/g, ' ');

function csvField(text: string) {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A value as JSON: numbers, booleans and `null` as such; every other value as its text. */
function jsonValue(value: unknown): unknown {
  if (isNull(value)) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  const typed = value as { $t?: string; v?: unknown };
  if (typed.$t === 'json' && typeof typed.v === 'string') {
    try {
      return JSON.parse(typed.v);
    } catch {
      return typed.v;
    }
  }
  if (typed.$t === 'integer' || typed.$t === 'decimal' || typed.$t === 'float') {
    const number = Number(typed.v);
    return Number.isSafeInteger(number) || typed.$t !== 'integer' ? number : typed.v;
  }
  return cellText(value);
}

const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** An array as PostgreSQL writes it: `{a,"b c",NULL}`. */
function postgresArray(values: readonly unknown[]): string {
  const item = (value: unknown): string => {
    if (isNull(value)) return 'NULL';
    if (Array.isArray(value)) return postgresArray(value);
    const text = cellText(value);
    return /^[^\s{}",\\]+$/.test(text) && text.toUpperCase() !== 'NULL'
      ? text
      : `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };
  return `{${values.map(item).join(',')}}`;
}

/** A value as a SQL literal of the engine. */
export function sqlLiteral(value: unknown, style: SqlStyle): string {
  if (isNull(value)) return 'NULL';
  const kind = classOf(value);
  if (kind === 'number') return cellText(value);
  if (kind === 'boolean') {
    const truth = value === true || (value as { v?: unknown }).v === 'true';
    return style.name === 'tsql' ? (truth ? '1' : '0') : truth ? 'TRUE' : 'FALSE';
  }
  if (kind === 'binary') {
    const hex = [...base64Bytes(String((value as { v?: unknown }).v ?? ''))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return style.name === 'tsql'
      ? `0x${hex}`
      : style.name === 'postgresql'
        ? `'\\x${hex}'`
        : `X'${hex}'`;
  }
  if (Array.isArray(value) || (value as { $t?: unknown }).$t === 'array') {
    const items = Array.isArray(value) ? value : ((value as { v?: unknown[] }).v ?? []);
    return quoted(postgresArray(items));
  }
  return quoted(cellText(value));
}

/** The table the columns come from, when they all come from one, as SQL names it. */
export function sourceTable(
  columns: readonly ResultColumn[],
  style: QuoteStyle,
): string | undefined {
  const origins = columns.map((column) => column.origin);
  const first = origins[0];
  if (!first?.table || origins.some((origin) => origin?.table !== first.table)) return undefined;
  const schema = first.schema;
  return [schema, first.table]
    .filter(Boolean)
    .map((name) => quoteName(name!, style))
    .join('.');
}

/** The copied cells written in a format. */
export function copyAs(cells: CopiedCells, format: CopyFormat, style?: SqlStyle): string {
  const { columns, rows } = cells;
  const names = columns.map((column) => column.name);
  switch (format) {
    case 'text':
      return rows.map((row) => row.map((value) => tabbed(cellText(value))).join('\t')).join('\n');
    case 'text-headers':
      return [names.join('\t'), copyAs(cells, 'text')].join('\n');
    case 'json':
      return JSON.stringify(
        rows.map((row) =>
          Object.fromEntries(names.map((name, index) => [name, jsonValue(row[index])])),
        ),
        null,
        2,
      );
    case 'csv':
      return [names, ...rows.map((row) => row.map(cellText))]
        .map((line) => line.map(csvField).join(','))
        .join('\r\n');
    case 'markdown': {
      const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return [
        `| ${names.map(cell).join(' | ')} |`,
        `| ${names.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${row.map((value) => cell(cellText(value))).join(' | ')} |`),
      ].join('\n');
    }
    case 'in': {
      const sql = style ?? { name: '', quoteOpen: '"', quoteClose: '"' };
      const values = [
        ...new Set(rows.flatMap((row) => row.map((value) => sqlLiteral(value, sql)))),
      ];
      return `(${values.join(', ')})`;
    }
    case 'insert': {
      const sql = style ?? { name: '', quoteOpen: '"', quoteClose: '"' };
      const table = sourceTable(columns, sql) ?? 'table_name';
      const list = columns
        .map((column) => quoteName(column.origin?.column ?? column.name, sql))
        .join(', ');
      return rows
        .map(
          (row) =>
            `INSERT INTO ${table} (${list}) VALUES (${row.map((value) => sqlLiteral(value, sql)).join(', ')});`,
        )
        .join('\n');
    }
  }
}
