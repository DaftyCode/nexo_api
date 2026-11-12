/**
 * MongoDB queries as people type them: in Extended JSON (canonical or relaxed) or in the
 * shell's syntax (`{status: 'A', _id: ObjectId("…"), at: {$gte: ISODate("…")}}`). The shell
 * syntax is read here and turned into Extended JSON before anything is sent. No JavaScript
 * is evaluated: only literals and the shell's type constructors are understood.
 */

import { type Json, QuerySyntaxError, Reader } from './mongo-query/reader';

export { QuerySyntaxError } from './mongo-query/reader';

/** A database of a deployment, as the explorer lists it. */
export interface DatabaseSummary {
  name: string;
  sizeOnDisk?: number;
  empty: boolean;
}

/** A collection, view or time series collection. */
export interface CollectionSummary {
  name: string;
  kind: 'collection' | 'view' | 'timeseries';
  /** The GridFS bucket it belongs to. */
  gridfs?: string;
  viewOn?: string;
  capped: boolean;
}

export interface IndexSummary {
  name: string;
  /** In canonical Extended JSON. */
  keys: Record<string, unknown>;
  unique: boolean;
}

export interface CollectionStats {
  count: number;
  size: number;
  storageSize: number;
  averageDocumentSize?: number;
  totalIndexSize: number;
  indexes: IndexSummary[];
  capped: boolean;
}

/** A page of results, each document in canonical Extended JSON. */
export interface DocumentPage {
  documents: Record<string, unknown>[];
  /** Reads the next page while the server keeps the cursor open. */
  cursor?: string;
  /** Stopped early at the size the interface receives at once. */
  truncated: boolean;
  elapsedMs: number;
}

/** A query field in shell syntax or Extended JSON, as Extended JSON. */
export function shellToExtendedJson(source: string): Json {
  return new Reader(source).document();
}

/** The fields of the query bar, as typed. */
export interface QueryForm {
  filter: string;
  projection: string;
  sort: string;
  collation: string;
  /** An index name, or its keys as a document. */
  hint: string;
  skip: string;
  limit: string;
}

export function emptyQueryForm(): QueryForm {
  return { filter: '', projection: '', sort: '', collation: '', hint: '', skip: '', limit: '' };
}

/** A query ready to send. */
export interface BuiltQuery {
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  hint?: string | Record<string, unknown>;
  skip?: number;
  limit?: number;
}

/** A field that cannot be used, with the message key and its values. */
export class QueryFieldError extends Error {
  constructor(
    readonly field: keyof QueryForm,
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(`${field}: ${key}`);
  }
}

const VARIABLE = /\{\{\s*([^{}]+?)\s*\}\}/;

function documentField(
  field: keyof QueryForm,
  source: string,
): Record<string, unknown> | undefined {
  if (!source.trim()) return undefined;
  const variable = VARIABLE.exec(source);
  if (variable) throw new QueryFieldError(field, 'mongo.undefinedVariable', { v0: variable[1] });
  let value: Json;
  try {
    value = shellToExtendedJson(source);
  } catch (error) {
    if (!(error instanceof QuerySyntaxError)) throw error;
    throw new QueryFieldError(field, 'mongo.syntax', {
      v0: error.reason,
      v1: error.line,
      v2: error.column,
      v3: error.detail,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new QueryFieldError(field, 'mongo.notDocument');
  return value as Record<string, unknown>;
}

function countField(field: 'skip' | 'limit', source: string): number | undefined {
  const text = source.trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new QueryFieldError(field, 'mongo.notCount');
  return Number(text) || undefined;
}

/**
 * The query to send. `resolve` replaces the variables of the active environment; one left
 * undefined is named.
 */
export function buildQuery(
  form: QueryForm,
  resolve: (text: string) => string = (t) => t,
): BuiltQuery {
  const query: BuiltQuery = {};
  const filter = documentField('filter', resolve(form.filter));
  const projection = documentField('projection', resolve(form.projection));
  const sort = documentField('sort', resolve(form.sort));
  const collation = documentField('collation', resolve(form.collation));
  if (filter) query.filter = filter;
  if (projection) query.projection = projection;
  if (sort) query.sort = sort;
  if (collation) query.collation = collation;
  const hint = resolve(form.hint).trim();
  if (hint.startsWith('{')) query.hint = documentField('hint', hint);
  else if (hint) query.hint = hint.replace(/^(['"])(.*)\1$/, '$2');
  const skip = countField('skip', form.skip);
  const limit = countField('limit', form.limit);
  if (skip) query.skip = skip;
  if (limit) query.limit = limit;
  return query;
}

/** A saved query, or one of the history: where it runs and what it asks. */
export interface MongoQueryValue extends QueryForm {
  /** The id of its connection document. */
  connection: string;
  database: string;
  collection: string;
  folder?: string;
}

/** Reads a stored query defensively. */
export function queryValue(value: unknown): MongoQueryValue {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const read = (key: string) => (typeof stored[key] === 'string' ? (stored[key] as string) : '');
  const query: MongoQueryValue = {
    ...emptyQueryForm(),
    connection: read('connection'),
    database: read('database'),
    collection: read('collection'),
  };
  for (const key of Object.keys(emptyQueryForm()) as (keyof QueryForm)[]) query[key] = read(key);
  if (read('folder')) query.folder = read('folder');
  return query;
}

/** One line that names a query: where it runs and its filter. */
export function querySummary(
  query: Pick<MongoQueryValue, 'database' | 'collection'> & Partial<QueryForm>,
): string {
  const filter = (query.filter ?? '').replace(/\s+/g, ' ').trim();
  const line = `${query.database}.${query.collection}${filter ? ` ${filter}` : ''}`;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
