/**
 * SQL generated from a table or from rows of a grid, as DBeaver's «Generate SQL»: `SELECT`,
 * `INSERT`, `UPDATE`, `DELETE` and `MERGE` with every column (values as `:name` parameters,
 * the key in the `WHERE`), or the statements of some rows with their values.
 */
import { SqlStyle, sqlLiteral } from './grid/copy';
import { ResultColumn } from './results';
import { quoteName } from './tree';

export type Generated = 'select' | 'insert' | 'update' | 'delete' | 'merge';
export const GENERATED: readonly Generated[] = ['select', 'insert', 'update', 'delete', 'merge'];

/** A table and its columns, the key among them. */
export interface GeneratedTable {
  schema?: string;
  name: string;
  /** The table as SQL already names it (from the tree), instead of its schema and name. */
  qualified?: string;
  columns: readonly { name: string; key?: boolean }[];
}

function named(table: GeneratedTable, style: SqlStyle) {
  const q = (name: string) => quoteName(name, style);
  const target =
    table.qualified ??
    [table.schema, table.name]
      .filter((part): part is string => !!part)
      .map(q)
      .join('.');
  const columns = table.columns.map((column) => column.name);
  const key = table.columns.filter((column) => column.key).map((column) => column.name);
  const where = (key.length ? key : columns).map((name) => `${q(name)} = :${name}`).join(' AND ');
  return { q, target, columns, key, where };
}

/** A statement for a table, with `:column` parameters to fill. */
export function generateFor(table: GeneratedTable, kind: Generated, style: SqlStyle): string {
  const { q, target, columns, key, where } = named(table, style);
  const list = columns.map(q).join(', ');
  const values = columns.map((name) => `:${name}`).join(', ');
  const others = columns.filter((name) => !key.includes(name));
  const set = (others.length ? others : columns).map((name) => `${q(name)} = :${name}`).join(', ');
  switch (kind) {
    case 'select':
      return `SELECT ${list}\nFROM ${target};`;
    case 'insert':
      return `INSERT INTO ${target} (${list})\nVALUES (${values});`;
    case 'update':
      return `UPDATE ${target}\nSET ${set}\nWHERE ${where};`;
    case 'delete':
      return `DELETE FROM ${target}\nWHERE ${where};`;
    case 'merge':
      return merge(style, target, columns.map(q), key.map(q), others.map(q), values);
  }
}

function merge(
  style: SqlStyle,
  target: string,
  columns: string[],
  key: string[],
  others: string[],
  values: string,
): string {
  const list = columns.join(', ');
  const on = key.length ? key : columns;
  if (style.name === 'mysql')
    return `INSERT INTO ${target} (${list})\nVALUES (${values})\nON DUPLICATE KEY UPDATE ${others
      .map((name) => `${name} = VALUES(${name})`)
      .join(', ')};`;
  if (style.name === 'sqlite')
    return `INSERT INTO ${target} (${list})\nVALUES (${values})\nON CONFLICT (${on.join(', ')}) DO UPDATE SET ${others
      .map((name) => `${name} = excluded.${name}`)
      .join(', ')};`;
  return `MERGE INTO ${target} t\nUSING (SELECT ${columns
    .map((name, at) => `${values.split(', ')[at]} AS ${name}`)
    .join(
      ', ',
    )}) s\nON ${on.map((name) => `t.${name} = s.${name}`).join(' AND ')}\nWHEN MATCHED THEN UPDATE SET ${others
    .map((name) => `${name} = s.${name}`)
    .join(', ')}\nWHEN NOT MATCHED THEN INSERT (${list}) VALUES (${columns
    .map((name) => `s.${name}`)
    .join(', ')});`;
}

/** The statements of some rows of a grid, with their values; the key from the columns. */
export function generateRows(
  kind: 'insert' | 'update' | 'delete',
  table: { schema?: string; name: string },
  columns: readonly ResultColumn[],
  rows: readonly (readonly unknown[])[],
  style: SqlStyle,
): string {
  const q = (name: string) => quoteName(name, style);
  const target = [table.schema, table.name]
    .filter((part): part is string => !!part)
    .map(q)
    .join('.');
  const names = columns.map((column) => column.origin?.column ?? column.name);
  const key = columns.map((column, at) => (column.key ? at : -1)).filter((at) => at >= 0);
  const keyed = key.length ? key : columns.map((_, at) => at);
  const condition = (row: readonly unknown[]) =>
    keyed
      .map((at) =>
        row[at] === null || row[at] === undefined
          ? `${q(names[at])} IS NULL`
          : `${q(names[at])} = ${sqlLiteral(row[at], style)}`,
      )
      .join(' AND ');
  return rows
    .map((row) => {
      if (kind === 'insert')
        return `INSERT INTO ${target} (${names.map(q).join(', ')}) VALUES (${row
          .map((value) => sqlLiteral(value, style))
          .join(', ')});`;
      if (kind === 'delete') return `DELETE FROM ${target} WHERE ${condition(row)};`;
      const set = row
        .map((value, at) =>
          key.includes(at) ? '' : `${q(names[at])} = ${sqlLiteral(value, style)}`,
        )
        .filter(Boolean)
        .join(', ');
      return `UPDATE ${target} SET ${set} WHERE ${condition(row)};`;
    })
    .join('\n');
}
