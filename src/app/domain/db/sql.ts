/**
 * What the SQL editor decides before a statement leaves: its variables replaced, the
 * confirmation it needs (as the backend will demand it), names written for the engine, and
 * the saved scripts.
 */
import { VariableScopes, resolveVariable } from '../variables';
import { DbNode, QuoteStyle, quoteName } from './tree';

/** What a statement does, as `db.split` classifies it. */
export interface Classification {
  kind: 'read' | 'write' | 'structure' | 'transaction' | 'session';
  missingWhere: boolean;
  truncate: boolean;
  drop: string[];
  drops: boolean;
}

/** A statement of a script, with its place in UTF-16 units and its first line. */
export interface SplitStatement {
  text: string;
  start: number;
  end: number;
  line: number;
  classification: Classification;
}

export interface SplitAnswer {
  statements: SplitStatement[];
  current: number | null;
}

/**
 * The statement with every `{{variable}}` of the active environment replaced. A variable
 * without a value, or a vault reference (secrets never go into SQL text), is named.
 */
export function withVariables(sql: string, scopes: VariableScopes): string {
  return sql.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name: string) => {
    const resolved = resolveVariable(name, scopes);
    if (name.startsWith('vault:'))
      throw new Error(`Vault secrets do not go into SQL text: «${name}»`);
    if (!resolved.defined || resolved.value === undefined)
      throw new Error(`The variable «${name}» has no value in the active environment`);
    return resolved.value;
  });
}

/** What has to be confirmed before a statement runs, as a message key and its values. */
export interface Confirmation {
  message: string;
  params?: Record<string, string>;
  /** Names to type, for a `DROP` that names them; sent back as `confirmName`. */
  names?: string;
}

/**
 * The confirmation a statement needs, in the order the backend checks: a `DROP`, a change of
 * every row, then any write on production. None for the rest.
 */
export function confirmationOf(
  classification: Classification,
  rules: { confirmWrites: boolean; confirmStructure: boolean },
): Confirmation | undefined {
  if (classification.drops) {
    const names = classification.drop.join(', ');
    return names
      ? { message: 'db.confirm.dropNamed', params: { v0: names }, names }
      : { message: 'db.confirm.drop' };
  }
  if (classification.missingWhere) return { message: 'db.confirm.everyRow' };
  if (classification.truncate) return { message: 'db.confirm.truncate' };
  const structure = classification.kind === 'structure';
  if (rules.confirmWrites && (classification.kind === 'write' || structure))
    return { message: 'db.confirm.production' };
  if (rules.confirmStructure && structure) return { message: 'db.confirm.structure' };
  return undefined;
}

/**
 * The name of an object of the tree as SQL writes it: its schema (when it is under one) and
 * its own name, each quoted as the engine needs. `nodes` are the nodes of its path, in order.
 */
export function qualifiedName(nodes: readonly DbNode[], style: QuoteStyle): string {
  const object = nodes.at(-1);
  if (!object) return '';
  const schema = [...nodes.slice(0, -1)].reverse().find((node) => node.kind === 'schema');
  return [schema, object]
    .filter(Boolean)
    .map((node) => quoteName(node!.label, style))
    .join('.');
}

/** The rows of a table grouped by some columns, most frequent first, as the Grouping panel asks. */
export function groupQuery(table: string, columns: readonly string[], style: QuoteStyle): string {
  const names = columns.map((column) => quoteName(column, style)).join(', ');
  return `SELECT ${names}, count(*) AS nexo_count FROM ${table} GROUP BY ${names} ORDER BY nexo_count DESC`;
}

/** The database a path of the tree is in, when the engine has several per server. */
export function databaseOf(nodes: readonly DbNode[]): string {
  return nodes.find((node) => node.kind === 'database')?.label ?? '';
}

/** A saved SQL script (`sql-script` document). */
export interface ScriptValue {
  connectionId: string;
  sql: string;
  folder?: string;
  database?: string;
}

export function readScript(value: unknown): ScriptValue {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof source[key] === 'string' ? (source[key] as string) : '');
  return {
    connectionId: text('connectionId'),
    sql: text('sql'),
    ...(text('folder').trim() ? { folder: text('folder').trim() } : {}),
    ...(text('database').trim() ? { database: text('database').trim() } : {}),
  };
}

/** A statement recorded in the history (`sql-history` document). */
export interface HistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  startedAt: number;
  durationMs: number;
  rows?: number;
  affected?: number | null;
  error?: string;
}

export function readHistory(id: string, value: unknown): HistoryEntry | undefined {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (typeof source['sql'] !== 'string' || typeof source['connectionId'] !== 'string')
    return undefined;
  const number = (key: string) => (typeof source[key] === 'number' ? source[key] : 0);
  return {
    id,
    connectionId: source['connectionId'],
    sql: source['sql'],
    startedAt: number('startedAt'),
    durationMs: number('durationMs'),
    ...(typeof source['rows'] === 'number' ? { rows: source['rows'] } : {}),
    ...(typeof source['affected'] === 'number' ? { affected: source['affected'] } : {}),
    ...(typeof source['error'] === 'string' ? { error: source['error'] } : {}),
  };
}
