/**
 * The model of a table the structure editor edits (DB-19), as `db.ddl.model` reads it: its
 * columns, keys, checks, foreign keys and indexes. Each column keeps the name it had
 * (`original`), so a renamed column is not taken for a new one. The editor changes a copy;
 * the driver writes the DDL of the difference.
 */
export interface ColumnModel {
  name: string;
  /** The name it had; empty for a new column. */
  original?: string;
  typeName: string;
  nullable: boolean;
  default?: string;
  identity: boolean;
  comment?: string;
}

export interface KeyModel {
  name?: string;
  columns: string[];
}

export interface CheckModel {
  name?: string;
  expression: string;
}

export interface ForeignKeyModel {
  name?: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface IndexModel {
  name: string;
  columns: string[];
  unique: boolean;
  method?: string;
  condition?: string;
}

export interface TableModel {
  schema?: string;
  name: string;
  original?: string;
  columns: ColumnModel[];
  primaryKey?: KeyModel;
  uniques: KeyModel[];
  checks: CheckModel[];
  foreignKeys: ForeignKeyModel[];
  indexes: IndexModel[];
  comment?: string;
  options?: Record<string, string>;
}

export interface DdlPlan {
  statements: string[];
  warnings: string[];
  transactional: boolean;
}

/** The actions of a foreign key, as every engine writes them. */
export const FOREIGN_ACTIONS = ['', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'] as const;

/** A table with nothing yet: its first column, the key. */
export function newTable(name: string, schema?: string): TableModel {
  return {
    ...(schema ? { schema } : {}),
    name,
    columns: [{ name: 'id', typeName: 'integer', nullable: false, identity: true }],
    primaryKey: { columns: ['id'] },
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  };
}

/** The model as read, with the arrays every model has (the driver leaves empty ones out). */
export function readTable(value: unknown): TableModel {
  const table = (value ?? {}) as Partial<TableModel>;
  return {
    ...table,
    name: table.name ?? '',
    columns: (table.columns ?? []).map((column) => ({
      ...column,
      nullable: !!column.nullable,
      identity: !!column.identity,
    })),
    uniques: table.uniques ?? [],
    checks: table.checks ?? [],
    foreignKeys: table.foreignKeys ?? [],
    indexes: table.indexes ?? [],
  };
}

/** A column added at the end, with a name no other column has. */
export function addColumn(table: TableModel): TableModel {
  let at = table.columns.length + 1;
  while (table.columns.some((column) => column.name === `column${at}`)) at++;
  return {
    ...table,
    columns: [
      ...table.columns,
      { name: `column${at}`, typeName: 'varchar(100)', nullable: true, identity: false },
    ],
  };
}

/** A column changed; a rename follows it into the keys and indexes that name it. */
export function changeColumn(
  table: TableModel,
  at: number,
  change: Partial<ColumnModel>,
): TableModel {
  const before = table.columns[at];
  if (!before) return table;
  const columns = table.columns.map((column, i) => (i === at ? { ...column, ...change } : column));
  if (change.name === undefined || change.name === before.name) return { ...table, columns };
  // An index names a column, or a column ` DESC`.
  const rename = (names: string[]) =>
    names.map((name) =>
      name === before.name
        ? change.name!
        : name === `${before.name} DESC`
          ? `${change.name} DESC`
          : name,
    );
  return {
    ...table,
    columns,
    ...(table.primaryKey
      ? { primaryKey: { ...table.primaryKey, columns: rename(table.primaryKey.columns) } }
      : {}),
    uniques: table.uniques.map((key) => ({ ...key, columns: rename(key.columns) })),
    foreignKeys: table.foreignKeys.map((key) => ({ ...key, columns: rename(key.columns) })),
    indexes: table.indexes.map((index) => ({ ...index, columns: rename(index.columns) })),
  };
}

/** A column removed, and with it from the keys and indexes (those left empty go too). */
export function removeColumn(table: TableModel, at: number): TableModel {
  const gone = table.columns[at]?.name;
  if (gone === undefined) return table;
  const without = (names: string[]) => names.filter((name) => name.replace(/ DESC$/, '') !== gone);
  const primary = table.primaryKey && without(table.primaryKey.columns);
  return {
    ...table,
    columns: table.columns.filter((_, i) => i !== at),
    ...(primary?.length
      ? { primaryKey: { ...table.primaryKey!, columns: primary } }
      : { primaryKey: undefined }),
    uniques: table.uniques
      .map((key) => ({ ...key, columns: without(key.columns) }))
      .filter((key) => key.columns.length),
    foreignKeys: table.foreignKeys.filter((key) => !key.columns.includes(gone)),
    indexes: table.indexes
      .map((index) => ({ ...index, columns: without(index.columns) }))
      .filter((index) => index.columns.length),
  };
}

/** Whether a field of a column differs from the column as it was read. */
export function columnChanged(
  original: TableModel | undefined,
  column: ColumnModel,
  field: keyof ColumnModel,
): boolean {
  if (!column.original) return true;
  const before = original?.columns.find((each) => each.name === column.original);
  if (!before) return true;
  return (before[field] ?? '') !== (column[field] ?? '');
}

/** Whether the table differs from the one read. */
export function tableChanged(original: TableModel | undefined, table: TableModel): boolean {
  return JSON.stringify(original) !== JSON.stringify(table);
}

/** The SQL the review shows: the statements, each ended. */
export function planScript(statements: readonly string[]): string {
  return statements.map((statement) => statement.trim().replace(/;$/, '') + ';').join('\n\n');
}
