/**
 * The statements of an object's «Data» tab, as DBeaver writes them: `SELECT *` of the table
 * with the condition the person typed, the quick filters taken from cells (their values
 * always as parameters, never in the text), the order of one or more columns, and the count
 * of the same rows. Names are quoted as the engine needs.
 */
import { SqlStyle } from './grid/copy';
import { DbNode, quoteName } from './tree';

export type QuickOperator = 'eq' | 'ne' | 'null' | 'notnull' | 'contains';

export interface QuickFilter {
  column: string;
  operator: QuickOperator;
  /** The cell's value, for `eq`, `ne` and `contains`. */
  value?: unknown;
}

export interface OrderLevel {
  column: string;
  descending: boolean;
}

/** What a «Data» tab asks for, kept with its tab in the workspace session. */
export interface TableQuery {
  /** A condition as SQL, written by the person. */
  where: string;
  quick: QuickFilter[];
  order: OrderLevel[];
  /** CQL: the person confirmed `ALLOW FILTERING`, which may read the whole cluster (DB-34). */
  allowFiltering?: boolean;
}

export function emptyTableQuery(): TableQuery {
  return { where: '', quick: [], order: [] };
}

/** How the engine marks parameters, as its driver says (`numbered`, `named`, `question`). */
export interface QueryStyle extends SqlStyle {
  parameters?: string;
}

function placeholder(style: QueryStyle, index: number) {
  if (style.parameters === 'numbered') return `$${index}`;
  if (style.parameters === 'named') return `@P${index}`;
  return '?';
}

/** A column as text, to look for a piece of text in it. */
function asText(column: string, style: QueryStyle) {
  if (style.name === 'postgresql') return `CAST(${column} AS TEXT)`;
  if (style.name === 'tsql') return `CAST(${column} AS NVARCHAR(MAX))`;
  if (style.name === 'mysql') return `CAST(${column} AS CHAR)`;
  if (style.name === 'sqlite') return `CAST(${column} AS TEXT)`;
  return `CAST(${column} AS VARCHAR(4000))`;
}

const likeText = (value: unknown) => {
  const typed = value as { v?: unknown } | null;
  const text = typeof value === 'string' ? value : String(typed?.v ?? value ?? '');
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
};

/** The `WHERE` of a query and its parameters, from the person's condition and quick filters. */
function conditions(query: TableQuery, style: QueryStyle) {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (query.where.trim()) parts.push(`(${query.where.trim()})`);
  for (const filter of query.quick) {
    const column = quoteName(filter.column, style);
    const next = () => {
      params.push(filter.operator === 'contains' ? likeText(filter.value) : filter.value);
      return placeholder(style, params.length);
    };
    switch (filter.operator) {
      case 'null':
        parts.push(`${column} IS NULL`);
        break;
      case 'notnull':
        parts.push(`${column} IS NOT NULL`);
        break;
      case 'eq':
        parts.push(`${column} = ${next()}`);
        break;
      case 'ne':
        parts.push(`(${column} <> ${next()} OR ${column} IS NULL)`);
        break;
      case 'contains': {
        const operator = style.name === 'postgresql' ? 'ILIKE' : 'LIKE';
        // MySQL's strings take a backslash as an escape, and its LIKE escapes with one.
        const escape = style.name === 'mysql' ? '' : ` ESCAPE '\\'`;
        parts.push(`${asText(column, style)} ${operator} ${next()}${escape}`);
        break;
      }
    }
  }
  return { where: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

/** ` ALLOW FILTERING` when the person confirmed it on a CQL table, else nothing. */
function filtering(query: TableQuery, style: QueryStyle) {
  return style.name === 'cql' && query.allowFiltering ? ' ALLOW FILTERING' : '';
}

/**
 * Cassandra refuses a filter that is not on the partition key until `ALLOW FILTERING` is
 * added: whether this error says so.
 */
export function asksToFilter(error: string, style: QueryStyle) {
  return style.name === 'cql' && /ALLOW FILTERING/i.test(error);
}

/** The rows of a table with the filter and order of its «Data» tab. */
export function tableSelect(table: string, query: TableQuery, style: QueryStyle) {
  const { where, params } = conditions(query, style);
  const order = query.order.length
    ? ` ORDER BY ${query.order
        .map((level) => `${quoteName(level.column, style)} ${level.descending ? 'DESC' : 'ASC'}`)
        .join(', ')}`
    : '';
  return { sql: `SELECT * FROM ${table}${where}${order}${filtering(query, style)}`, params };
}

/** How many rows the same filter keeps. */
export function tableCount(table: string, query: TableQuery, style: QueryStyle) {
  const { where, params } = conditions(query, style);
  return { sql: `SELECT count(*) FROM ${table}${where}${filtering(query, style)}`, params };
}

/** Puts a column first in the order, or turns it round when it already is. */
export function orderBy(query: TableQuery, column: string, add: boolean): TableQuery {
  const current = query.order.find((level) => level.column === column);
  const others = query.order.filter((level) => level.column !== column);
  const level = { column, descending: current ? !current.descending : false };
  return { ...query, order: add ? [...others, level] : [level] };
}

/** The table of a path of the tree, for the engines whose tree is `…/schema/folder/name`. */
export function tableOfPath(path: readonly string[], nodes: readonly DbNode[], style: SqlStyle) {
  const object = nodes.at(-1);
  const schema = [...nodes.slice(0, -1)].reverse().find((node) => node.kind === 'schema');
  if (object && schema)
    return `${quoteName(schema.label, style)}.${quoteName(object.label, style)}`;
  const [name, , schemaName] = [...path].reverse();
  return [schemaName, name]
    .filter(Boolean)
    .map((part) => quoteName(part, style))
    .join('.');
}

/** A foreign key as `db.describe` lists it: its columns and those it points to. */
export interface ForeignKey {
  name: string;
  columns: string[];
  schema: string;
  table: string;
  referenced: string[];
}

/** The keys of a section of `db.describe` (`foreign-keys` or `references`). */
export function foreignKeys(
  section: { columns: readonly string[]; rows: readonly unknown[][] } | undefined,
  ends: { schema: string; table: string },
  text: (value: unknown) => string,
): ForeignKey[] {
  if (!section) return [];
  const at = (name: string) => section.columns.indexOf(name);
  const list = (value: unknown) =>
    text(value)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  return section.rows
    .filter(() => at('Columns') >= 0 && at(ends.table) >= 0)
    .map((row) => ({
      name: text(row[at('Name')]),
      columns: list(row[at('Columns')]),
      schema: at(ends.schema) >= 0 ? text(row[at(ends.schema)]) : '',
      table: text(row[at(ends.table)]),
      referenced: list(row[at('Referenced columns')]),
    }));
}
