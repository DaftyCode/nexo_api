/**
 * Test data for a table (DB-27): a generator for each column, chosen from its type and its
 * name (`email`, `phone`, `created_at`…) and changed by the person, as the engine's generators
 * (`nexo_domain::mock`) take them. Columns the database fills (identity, a default) are left
 * out unless asked for; a foreign key draws from the keys of the table it references.
 */
import type { ColumnModel, ForeignKeyModel, TableModel } from './structure';

export type MockCatalog =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'city'
  | 'country'
  | 'company'
  | 'street'
  | 'iban'
  | 'uuid'
  | 'url';
export const MOCK_CATALOGS: readonly MockCatalog[] = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'city',
  'country',
  'company',
  'street',
  'iban',
  'uuid',
  'url',
];
export type MockLanguage = 'en' | 'es';

export type MockGenerator =
  | { kind: 'sequence'; start: number; step: number }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'decimal'; min: number; max: number; scale: number }
  | { kind: 'text'; min: number; max: number }
  | { kind: 'list'; values: string[] }
  | { kind: 'pattern'; pattern: string }
  | { kind: 'catalog'; catalog: MockCatalog; language: MockLanguage }
  | { kind: 'date'; from: string; to: string }
  | { kind: 'timestamp'; from: string; to: string }
  | { kind: 'boolean'; ratio: number }
  | { kind: 'json'; template: string }
  | { kind: 'binary'; size: number }
  | { kind: 'foreign'; values: unknown[] };
export type MockKind = MockGenerator['kind'];
export const MOCK_KINDS: readonly MockKind[] = [
  'sequence',
  'integer',
  'decimal',
  'text',
  'list',
  'pattern',
  'catalog',
  'date',
  'timestamp',
  'boolean',
  'json',
  'binary',
  'foreign',
];

/** A column of the table with what fills it. */
export interface MockColumnPlan {
  name: string;
  typeName: string;
  include: boolean;
  /** Why it is left out unless asked: the database fills it. */
  filled?: 'identity' | 'default';
  generator: MockGenerator;
  /** The share of NULL, from 0 to 1, where the column takes it. */
  nulls: number;
  nullable: boolean;
  unique: boolean;
  length?: number;
  /** The key whose values a foreign column draws from. */
  foreign?: ForeignKeyModel;
}

/** The rows a run makes by default and at most, and a batch at most. */
export const MOCK_ROWS = 1_000;
export const MOCK_MAX_ROWS = 1_000_000;
export const MOCK_MAX_BATCH = 5_000;
export const MOCK_PREVIEW = 20;

/** The length, precision and scale a type says: `varchar(40)`, `numeric(10,2)`. */
export function typeSize(typeName: string): {
  length?: number;
  precision?: number;
  scale?: number;
} {
  const match = /\((\d+)(?:\s*,\s*(\d+))?\)/.exec(typeName);
  if (!match) return {};
  const first = Number(match[1]);
  if (match[2] !== undefined) return { precision: first, scale: Number(match[2]) };
  return /char|text|string|binary/i.test(typeName) ? { length: first } : { precision: first };
}

const FROM = '2020-01-01';
const TO = '2025-12-31';

/** The generator a name says, when it says one. */
function byName(name: string, language: MockLanguage): MockGenerator | undefined {
  const text = name.toLowerCase();
  const catalog = (catalog: MockCatalog): MockGenerator => ({ kind: 'catalog', catalog, language });
  if (text.includes('email') || text.includes('correo')) return catalog('email');
  if (/phone|mobile|^tel|telefono/.test(text)) return catalog('phone');
  if (/first_?name|given_?name|^nombre$/.test(text)) return catalog('firstName');
  if (/last_?name|surname|apellido/.test(text)) return catalog('lastName');
  if (/(^|_)(full_?)?name$|^nombre_completo$/.test(text)) return catalog('fullName');
  if (/city|town|ciudad/.test(text)) return catalog('city');
  if (/country|pais/.test(text)) return catalog('country');
  if (/company|empresa/.test(text)) return catalog('company');
  if (/street|address|direccion/.test(text)) return catalog('street');
  if (text.includes('iban')) return catalog('iban');
  if (/url|website|link/.test(text)) return catalog('url');
  if (/uuid|guid/.test(text)) return catalog('uuid');
  return undefined;
}

/** The generator of a column, from its type, its name and its keys. */
export function autoGenerator(
  column: ColumnModel,
  table: TableModel,
  language: MockLanguage = 'en',
): MockGenerator {
  const type = column.typeName.toLowerCase();
  const size = typeSize(type);
  const primary = table.primaryKey?.columns ?? [];
  if (table.foreignKeys.some((key) => key.columns.length === 1 && key.columns[0] === column.name))
    return { kind: 'foreign', values: [] };
  if (/^bool|^bit\b|tinyint\(1\)/.test(type)) return { kind: 'boolean', ratio: 0.5 };
  if (/int|serial/.test(type)) {
    if (primary.length === 1 && primary[0] === column.name)
      return { kind: 'sequence', start: 1, step: 1 };
    const max = /tinyint/.test(type) ? 127 : /smallint/.test(type) ? 32_767 : 1_000_000;
    return { kind: 'integer', min: 1, max };
  }
  if (/numeric|decimal|money|real|double|float/.test(type)) {
    const scale = size.scale ?? 2;
    const digits = (size.precision ?? 8) - scale;
    return { kind: 'decimal', min: 0, max: Math.min(10 ** Math.max(digits, 1) - 1, 10_000), scale };
  }
  if (/uuid|uniqueidentifier/.test(type)) return { kind: 'catalog', catalog: 'uuid', language };
  if (/json/.test(type))
    return {
      kind: 'json',
      template: '{"id": {{row}}, "name": "{{firstName}}", "tags": ["{{word}}"]}',
    };
  if (/bytea|blob|binary|image/.test(type)) return { kind: 'binary', size: 16 };
  if (/timestamp|datetime/.test(type)) return { kind: 'timestamp', from: FROM, to: TO };
  if (/^date/.test(type)) return { kind: 'date', from: FROM, to: TO };
  if (/^time/.test(type))
    return { kind: 'list', values: ['08:00:00', '09:30:00', '12:15:00', '17:45:00', '22:00:00'] };
  const named = byName(column.name, language);
  if (named) return named;
  return { kind: 'text', min: 5, max: Math.min(size.length ?? 30, 30) };
}

/** Whether the values of a column must be unique: its key, a unique constraint or index. */
function uniqueColumn(column: string, table: TableModel): boolean {
  const single = (columns: readonly string[]) => columns.length === 1 && columns[0] === column;
  return (
    single(table.primaryKey?.columns ?? []) ||
    table.uniques.some((key) => single(key.columns)) ||
    table.indexes.some((index) => index.unique && single(index.columns))
  );
}

/** What fills each column of a table, as the dialog starts with it. */
export function mockPlan(table: TableModel, language: MockLanguage = 'en'): MockColumnPlan[] {
  return table.columns.map((column) => {
    const filled = column.identity ? 'identity' : column.default ? 'default' : undefined;
    const foreign = table.foreignKeys.find(
      (key) => key.columns.length === 1 && key.columns[0] === column.name,
    );
    const { length } = typeSize(column.typeName);
    return {
      name: column.name,
      typeName: column.typeName,
      include: !filled,
      ...(filled ? { filled } : {}),
      generator: autoGenerator(column, table, language),
      nulls: 0,
      nullable: column.nullable,
      unique: uniqueColumn(column.name, table),
      ...(length ? { length } : {}),
      ...(foreign ? { foreign } : {}),
    };
  });
}

/** A generator of another kind, with its usual settings. */
export function generatorOf(kind: MockKind, language: MockLanguage = 'en'): MockGenerator {
  switch (kind) {
    case 'sequence':
      return { kind, start: 1, step: 1 };
    case 'integer':
      return { kind, min: 1, max: 1000 };
    case 'decimal':
      return { kind, min: 0, max: 1000, scale: 2 };
    case 'text':
      return { kind, min: 5, max: 30 };
    case 'list':
      return { kind, values: ['a', 'b', 'c'] };
    case 'pattern':
      return { kind, pattern: 'AAA-999' };
    case 'catalog':
      return { kind, catalog: 'fullName', language };
    case 'date':
    case 'timestamp':
      return { kind, from: FROM, to: TO };
    case 'boolean':
      return { kind, ratio: 0.5 };
    case 'json':
      return { kind, template: '{"id": {{row}}}' };
    case 'binary':
      return { kind, size: 16 };
    case 'foreign':
      return { kind, values: [] };
  }
}

/** The columns of a run as the engine takes them: those included, with their keys read. */
export function mockColumns(
  plan: readonly MockColumnPlan[],
  keys: Readonly<Record<string, unknown[]>> = {},
): Record<string, unknown>[] {
  return plan
    .filter((column) => column.include)
    .map((column) => ({
      name: column.name,
      generator:
        column.generator.kind === 'foreign'
          ? { kind: 'foreign', values: keys[column.name] ?? column.generator.values }
          : column.generator,
      nulls: column.nullable ? column.nulls : 0,
      unique: column.unique,
      ...(column.length ? { length: column.length } : {}),
    }));
}
