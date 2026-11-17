/** The options the SQL editor offers for a completion context, from the schema it knows. */
import { CompletionContext, SchemaTable, TableRef } from './completion';
import { QuoteStyle, quoteName } from './tree';

export interface Suggestion {
  label: string;
  /** What replaces the word typed. */
  apply: string;
  type: 'table' | 'view' | 'column' | 'join' | 'columns' | 'keyword' | 'function';
  detail?: string;
}

/** What the dialect says it has, and how it quotes names. */
export interface DialectWords extends QuoteStyle {
  keywords: readonly string[];
  functions: readonly string[];
}

const same = (a: string | undefined, b: string | undefined) =>
  (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** The table of the schema a reference names. */
export function resolve(schema: readonly SchemaTable[], ref: TableRef): SchemaTable | undefined {
  return schema.find(
    (table) => same(table.name, ref.name) && (!ref.schema || same(table.schema, ref.schema)),
  );
}

function tableOptions(schema: readonly SchemaTable[], style: DialectWords): Suggestion[] {
  const counts = new Map<string, number>();
  for (const table of schema)
    counts.set(table.name.toLowerCase(), (counts.get(table.name.toLowerCase()) ?? 0) + 1);
  return schema.map((table) => {
    const name = quoteName(table.name, style);
    const qualify = (counts.get(table.name.toLowerCase()) ?? 0) > 1 && table.schema;
    return {
      label: table.name,
      apply: qualify ? `${quoteName(table.schema!, style)}.${name}` : name,
      type: table.kind,
      ...(table.schema ? { detail: table.schema } : {}),
    };
  });
}

function columnOptions(
  schema: readonly SchemaTable[],
  refs: readonly TableRef[],
  style: DialectWords,
): Suggestion[] {
  return refs.flatMap((ref) =>
    (resolve(schema, ref)?.columns ?? []).map((column) => ({
      label: column.name,
      apply: quoteName(column.name, style),
      type: 'column' as const,
      detail: refs.length > 1 ? `${ref.alias ?? ref.name} · ${column.type}` : column.type,
    })),
  );
}

/** The conditions of the foreign keys between the joined table and the others. */
function joinOptions(
  schema: readonly SchemaTable[],
  tables: readonly TableRef[],
  joined: TableRef,
  style: DialectWords,
): Suggestion[] {
  const name = (ref: TableRef) => quoteName(ref.alias ?? ref.name, style);
  const condition = (
    left: TableRef,
    columns: readonly string[],
    right: TableRef,
    to: readonly string[],
  ) =>
    columns
      .map(
        (column, at) =>
          `${name(left)}.${quoteName(column, style)} = ${name(right)}.${quoteName(to[at] ?? column, style)}`,
      )
      .join(' AND ');
  const found: string[] = [];
  const target = resolve(schema, joined);
  for (const other of tables.filter(
    (ref) => ref !== joined && !same(ref.alias ?? ref.name, joined.alias ?? joined.name),
  )) {
    const table = resolve(schema, other);
    for (const key of target?.keys ?? [])
      if (same(key.table, other.name))
        found.push(condition(joined, key.columns, other, key.referenced));
    for (const key of table?.keys ?? [])
      if (same(key.table, joined.name))
        found.push(condition(other, key.columns, joined, key.referenced));
  }
  return [...new Set(found)].map((text) => ({ label: text, apply: text, type: 'join' }));
}

/** The options for a context, best first. */
export function suggestions(
  context: CompletionContext,
  schema: readonly SchemaTable[],
  words: DialectWords,
): Suggestion[] {
  switch (context.kind) {
    case 'none':
      return [];
    case 'tables':
      return tableOptions(schema, words);
    case 'columns':
      return columnOptions(schema, context.of, words);
    case 'join':
      return [
        ...joinOptions(schema, context.tables, context.joined, words),
        ...columnOptions(schema, context.tables, words),
      ];
    case 'star': {
      const several = context.tables.length > 1;
      const all = context.tables.flatMap((ref) =>
        (resolve(schema, ref)?.columns ?? []).map((column) =>
          several
            ? `${quoteName(ref.alias ?? ref.name, words)}.${quoteName(column.name, words)}`
            : quoteName(column.name, words),
        ),
      );
      return all.length
        ? [{ label: all.join(', '), apply: all.join(', '), type: 'columns', detail: '*' }]
        : [];
    }
    case 'any':
      return [
        ...columnOptions(schema, context.tables, words),
        ...words.functions.map((name) => ({
          label: name,
          apply: `${name}(`,
          type: 'function' as const,
        })),
        ...words.keywords.map((name) => ({
          label: name.toUpperCase(),
          apply: name.toUpperCase(),
          type: 'keyword' as const,
        })),
      ];
  }
}
