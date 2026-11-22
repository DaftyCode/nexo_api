/**
 * What the canvas and the panels of the visual query builder do to its model: add a table
 * (joined by its foreign key to one already there, when it has one), choose a column, join
 * two columns, change the kind of a join and take a table away. Each returns a new model.
 */
import type { ErdForeignKey } from '../erd';
import { JOIN_KINDS, QueryModel, QueryTable } from '../query-model';

/** What the builder knows of a table: its columns and the foreign keys it holds. */
export interface BuilderTable {
  path: string[];
  schema?: string;
  name: string;
  columns: string[];
  keys: ErdForeignKey[];
}

/** An expression naming a column of a table by its alias, quoted by `quote`. */
export type Quote = (name: string) => string;
export const columnOf = (alias: string, column: string, quote: Quote) =>
  `${quote(alias)}.${quote(column)}`;

/** How a table is named in the statement: its alias, or its name when it has none. */
export const referenceOf = (table: QueryTable) => table.alias || (table.path.at(-1) ?? '');

/** An alias for a table that no other has: its first letter, then a number. */
export function aliasFor(name: string, taken: readonly string[]): string {
  const base = (name.match(/[a-z]/i)?.[0] ?? 't').toLowerCase();
  if (!taken.includes(base)) return base;
  let number = 2;
  while (taken.includes(`${base}${number}`)) number++;
  return `${base}${number}`;
}

const sameTable = (table: QueryTable, schema: string | undefined, name: string) =>
  table.path.at(-1) === name && (!schema || table.path.length < 2 || table.path.at(-2) === schema);

/**
 * The model with `table` added. When a foreign key relates it to a table already there (one
 * way or the other), the join by that key is proposed; otherwise it is an inner join that
 * the person completes by joining two columns.
 */
export function addTable(
  model: QueryModel,
  table: BuilderTable,
  known: readonly BuilderTable[],
  quote: Quote,
): QueryModel {
  const alias = aliasFor(
    table.name,
    model.tables.map((each) => each.alias),
  );
  const added: QueryTable = {
    path: table.schema ? [table.schema, table.name] : [table.name],
    alias,
  };
  const tables = [...model.tables, added];
  if (model.tables.length === 0) return { ...model, tables };
  const on = [];
  for (const [index, existing] of model.tables.entries()) {
    const other = known.find((each) => sameTable(existing, each.schema, each.name));
    // The new table references one already there.
    for (const key of table.keys)
      if (sameTable(existing, key.referencedSchema, key.referencedTable))
        on.push(
          ...key.columns.map((column, at) => ({
            left: columnOf(alias, column, quote),
            operator: '=' as const,
            right: columnOf(referenceOf(existing), key.referencedColumns[at] ?? column, quote),
          })),
        );
    // One already there references the new table.
    for (const key of other?.keys ?? [])
      if (
        key.referencedTable === table.name &&
        (!key.referencedSchema || key.referencedSchema === table.schema)
      )
        on.push(
          ...key.columns.map((column, at) => ({
            left: columnOf(alias, key.referencedColumns[at] ?? column, quote),
            operator: '=' as const,
            right: columnOf(referenceOf(model.tables[index]), column, quote),
          })),
        );
    if (on.length) break;
  }
  return {
    ...model,
    tables,
    joins: [...model.joins, { table: tables.length - 1, kind: 'inner', on }],
  };
}

/** The model with a column chosen, or no longer chosen. */
export function toggleColumn(model: QueryModel, expression: string): QueryModel {
  const chosen = model.columns.some((column) => column.expression === expression);
  return {
    ...model,
    columns: chosen
      ? model.columns.filter((column) => column.expression !== expression)
      : [...model.columns, { expression, alias: '', aggregate: '' }],
  };
}

/** The model with two columns of two tables joined by their equality. */
export function joinColumns(
  model: QueryModel,
  from: { table: number; expression: string },
  to: { table: number; expression: string },
): QueryModel {
  if (from.table === to.table) return model;
  const later = Math.max(from.table, to.table);
  if (later === 0) return model;
  const [left, right] = later === from.table ? [from, to] : [to, from];
  const comparison = { left: left.expression, operator: '=' as const, right: right.expression };
  const exists = model.joins.some((join) => join.table === later);
  return {
    ...model,
    joins: exists
      ? model.joins.map((join) =>
          join.table === later ? { ...join, on: [...join.on, comparison] } : join,
        )
      : [...model.joins, { table: later, kind: 'inner', on: [comparison] }],
  };
}

/** The model with the join of a table changed to the next kind (inner, left, right, full). */
export function nextJoinKind(model: QueryModel, table: number): QueryModel {
  return {
    ...model,
    joins: model.joins.map((join) =>
      join.table === table
        ? { ...join, kind: JOIN_KINDS[(JOIN_KINDS.indexOf(join.kind) + 1) % JOIN_KINDS.length] }
        : join,
    ),
  };
}

/**
 * The model without a table, its join and the columns, orders and groups that name it by its
 * alias; the joins after it point at their tables' new places.
 */
export function removeTable(model: QueryModel, index: number, quote: Quote): QueryModel {
  const table = model.tables[index];
  if (!table) return model;
  const reference = referenceOf(table);
  const prefixes = [`${reference}.`, `${quote(reference)}.`];
  const names = (text: string) => prefixes.some((prefix) => text.includes(prefix));
  const tables = model.tables.filter((_, at) => at !== index);
  const joins = model.joins
    .filter((join) => join.table !== index)
    .map((join) => ({
      ...join,
      table: join.table > index ? join.table - 1 : join.table,
      on: join.on.filter((each) => !names(each.left) && !names(each.right)),
    }))
    // The first table is never joined.
    .filter((join) => join.table > 0);
  return {
    ...model,
    tables,
    joins,
    columns: model.columns.filter((column) => !names(column.expression)),
    groupBy: model.groupBy.filter((each) => !names(each)),
    orderBy: model.orderBy.filter((each) => !names(each.expression)),
  };
}
