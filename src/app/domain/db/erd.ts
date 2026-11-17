/**
 * The model of an entity-relationship diagram (DB-20), as DBeaver's ERD: each table an entity
 * with its columns and their keys, and each foreign key a relation from the table that holds
 * it to the one it references, with its cardinality. Built from the structure of each table
 * (`ddl.model`) or, for a driver without it, from its description (`db.describe`).
 */
import type { TableModel } from './structure';

export interface ErdColumn {
  name: string;
  type: string;
  nullable: boolean;
  primary: boolean;
  foreign: boolean;
}

export interface ErdEntity {
  /** `schema.table`, or the table alone where there are no schemas. */
  key: string;
  schema?: string;
  name: string;
  /** Where the table is in the tree, to open it. */
  path: string[];
  columns: ErdColumn[];
}

export interface ErdForeignKey {
  name?: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface ErdRelation {
  key: string;
  name: string;
  /** The entity that holds the foreign key. */
  from: string;
  fromColumns: string[];
  /** The entity it references. */
  to: string;
  toColumns: string[];
  /** One row of `to` for at most one of `from` (the key is unique), or for many. */
  many: boolean;
  /** A row of `from` may reference nothing (a key column takes `NULL`). */
  optional: boolean;
  /** The key is part of the primary key of `from` (IDEF1X draws it solid). */
  identifying: boolean;
}

export interface ErdModel {
  entities: ErdEntity[];
  relations: ErdRelation[];
}

/** A table read for the diagram: its entity and the foreign keys it holds. */
export interface ErdTable {
  entity: ErdEntity;
  keys: ErdForeignKey[];
  /** Sets of columns that are unique (the primary key, unique constraints). */
  unique: string[][];
}

export const entityKey = (name: string, schema?: string) => (schema ? `${schema}.${name}` : name);

/** A table from its structure (`ddl.model`). */
export function tableFromModel(model: TableModel, path: readonly string[]): ErdTable {
  const primary = model.primaryKey?.columns ?? [];
  const foreign = new Set(model.foreignKeys.flatMap((key) => key.columns));
  return {
    entity: {
      key: entityKey(model.name, model.schema),
      ...(model.schema ? { schema: model.schema } : {}),
      name: model.name,
      path: [...path],
      columns: model.columns.map((column) => ({
        name: column.name,
        type: column.typeName,
        nullable: column.nullable,
        primary: primary.includes(column.name),
        foreign: foreign.has(column.name),
      })),
    },
    keys: model.foreignKeys.map((key) => ({
      ...(key.name ? { name: key.name } : {}),
      columns: key.columns,
      ...(key.referencedSchema ? { referencedSchema: key.referencedSchema } : {}),
      referencedTable: key.referencedTable,
      referencedColumns: key.referencedColumns,
    })),
    unique: [...(primary.length ? [primary] : []), ...model.uniques.map((key) => key.columns)],
  };
}

interface Section {
  id: string;
  columns: readonly string[];
  rows: readonly (readonly unknown[])[];
}

/** A value of a described row, as text. */
const text = (value: unknown) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? String((value as { v?: unknown }).v ?? '')
      : String(value);
const list = (value: unknown) =>
  text(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
/** `YES`, `true`, `1`: a column that takes `NULL`. */
const yes = (value: unknown) => /^(yes|true|t|1)$/i.test(text(value));

/**
 * A table from its description, for a driver without `ddl.model`: the `Name`, `Type`,
 * `Nullable` and `Key` (`PRI`) of its columns, and the foreign keys of its `foreign-keys`
 * section (`Columns`, `Referenced schema`, `Referenced table`, `Referenced columns`).
 */
export function tableFromDescription(
  sections: readonly Section[],
  name: string,
  schema: string | undefined,
  path: readonly string[],
): ErdTable {
  const section = (id: string) => sections.find((each) => each.id === id);
  const cell = (part: Section, row: readonly unknown[], column: string) =>
    part.columns.indexOf(column) >= 0 ? row[part.columns.indexOf(column)] : undefined;
  const columnsPart = section('columns');
  const keysPart = section('foreign-keys');
  const keys: ErdForeignKey[] = (keysPart?.rows ?? []).map((row) => {
    const referencedSchema = text(cell(keysPart!, row, 'Referenced schema'));
    return {
      name: text(cell(keysPart!, row, 'Name')),
      columns: list(cell(keysPart!, row, 'Columns')),
      ...(referencedSchema ? { referencedSchema } : {}),
      referencedTable: text(cell(keysPart!, row, 'Referenced table')),
      referencedColumns: list(cell(keysPart!, row, 'Referenced columns')),
    };
  });
  const foreign = new Set(keys.flatMap((key) => key.columns));
  const columns = (columnsPart?.rows ?? []).map((row) => ({
    name: text(cell(columnsPart!, row, 'Name')),
    type: text(cell(columnsPart!, row, 'Type')),
    nullable: yes(cell(columnsPart!, row, 'Nullable')),
    primary: /^pri/i.test(text(cell(columnsPart!, row, 'Key'))),
    foreign: false,
  }));
  for (const column of columns) column.foreign = foreign.has(column.name);
  const primary = columns.filter((column) => column.primary).map((column) => column.name);
  return {
    entity: {
      key: entityKey(name, schema),
      ...(schema ? { schema } : {}),
      name,
      path: [...path],
      columns,
    },
    keys,
    unique: primary.length ? [primary] : [],
  };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name) => b.includes(name));

/**
 * The diagram of some tables: their entities, and a relation for each foreign key whose
 * referenced table is among them (a key to a table left out is not drawn). A key without a
 * schema refers to its own table's schema.
 */
export function erdModel(tables: readonly ErdTable[]): ErdModel {
  const entities = tables.map((table) => table.entity);
  const known = new Map(entities.map((entity) => [entity.key.toLowerCase(), entity]));
  const relations: ErdRelation[] = [];
  for (const table of tables) {
    const from = table.entity;
    for (const [at, key] of table.keys.entries()) {
      const schema = key.referencedSchema ?? from.schema;
      const to =
        known.get(entityKey(key.referencedTable, schema).toLowerCase()) ??
        known.get(key.referencedTable.toLowerCase());
      if (!to) continue;
      const columns = from.columns.filter((column) => key.columns.includes(column.name));
      const primary = from.columns.filter((column) => column.primary).map((column) => column.name);
      relations.push({
        key: `${from.key}#${key.name || at}`,
        name: key.name || `${from.name} → ${to.name}`,
        from: from.key,
        fromColumns: key.columns,
        to: to.key,
        toColumns: key.referencedColumns,
        many: !table.unique.some((unique) => same(unique, key.columns)),
        optional: columns.some((column) => column.nullable),
        identifying: key.columns.length > 0 && key.columns.every((name) => primary.includes(name)),
      });
    }
  }
  return { entities, relations };
}

/** What each entity shows: every column, the key columns, or only its name. */
export type ErdDetail = 'all' | 'keys' | 'none';
export type ErdNotation = 'idef1x' | 'crowsfoot' | 'uml';
export const ERD_NOTATIONS: readonly ErdNotation[] = ['idef1x', 'crowsfoot', 'uml'];

/** The columns an entity draws for a detail. */
export function shownColumns(entity: ErdEntity, detail: ErdDetail): ErdColumn[] {
  if (detail === 'none') return [];
  if (detail === 'keys') return entity.columns.filter((column) => column.primary || column.foreign);
  return entity.columns;
}
