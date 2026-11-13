/**
 * MongoDB indexes and the profiler as the explorer shows them: what each index is, read from
 * its definition; the form of a new index; and the operations the profiler recorded, with
 * the query of each one that can be explained again.
 */
import { bsonType, relaxed } from './bson';
import { BuiltQuery } from './mongo-query';
import { compact } from './mongo-explain';
import { WriteTextError, parseValue } from './mongo-write';

type Plain = Record<string, unknown>;

/** An index as `mongo.indexes` lists it. */
export interface IndexDetail {
  name: string;
  /** Its definition (`key` and options), in canonical Extended JSON. */
  spec: Plain;
  /** Bytes on disk. */
  size?: number;
  /** Operations that used it since `since`. */
  accesses?: number;
  since?: string;
}

/** What an index is. Kinds are message keys. */
export interface IndexView {
  name: string;
  /** Its keys as the shell writes them: `{ status: 1, at: -1 }`. */
  keys: string;
  kinds: string[];
  /** Seconds after which documents expire (a TTL index). */
  ttl?: number;
  /** The filter of a partial index. */
  partial?: string;
  hidden: boolean;
  /** The `_id` index, which can be neither hidden nor dropped. */
  id: boolean;
}

const isPlain = (value: unknown): value is Plain =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function indexView(index: IndexDetail): IndexView {
  const spec = relaxed(index.spec) as Plain;
  const keys = isPlain(spec['key']) ? spec['key'] : {};
  const fields = Object.keys(keys);
  const values = Object.values(keys);
  const kinds: string[] = [];
  // A text index stores its fields as `_fts` and `_ftsx`: one index, not a compound one.
  const text = values.includes('text') || fields.includes('_fts');
  if (fields.length > 1 && !text) kinds.push('Compound');
  if (spec['unique'] === true) kinds.push('Unique');
  if (spec['sparse'] === true) kinds.push('Sparse');
  if (isPlain(spec['partialFilterExpression'])) kinds.push('Partial');
  const ttl =
    typeof spec['expireAfterSeconds'] === 'number' ? spec['expireAfterSeconds'] : undefined;
  if (ttl !== undefined) kinds.push('TTL');
  if (text) kinds.push('Text');
  if (values.some((value) => value === '2dsphere' || value === '2d')) kinds.push('Geospatial');
  if (values.includes('hashed')) kinds.push('Hashed');
  if (fields.some((field) => field === '$**' || field.endsWith('.$**'))) kinds.push('Wildcard');
  const hidden = spec['hidden'] === true;
  if (hidden) kinds.push('Hidden');
  // A text index lists the fields it searches in `weights`.
  const weights = isPlain(spec['weights']) ? Object.keys(spec['weights']) : [];
  const shown =
    text && weights.length
      ? Object.fromEntries([
          ...fields.filter((f) => f !== '_fts' && f !== '_ftsx').map((f) => [f, keys[f]]),
          ...weights.map((field) => [field, 'text']),
        ])
      : keys;
  return {
    name: index.name,
    keys: compact(shown),
    kinds,
    ...(ttl === undefined ? {} : { ttl }),
    ...(isPlain(spec['partialFilterExpression'])
      ? { partial: compact(spec['partialFilterExpression']) }
      : {}),
    hidden,
    id: index.name === '_id_',
  };
}

/**
 * The name MongoDB gives an index created without one: each field and its type, joined by
 * `_` (`status_1_at_-1`, `title_text`).
 */
export function defaultIndexName(keys: Plain): string {
  return Object.entries(relaxed(keys) as Plain)
    .map(([field, kind]) => `${field}_${typeof kind === 'object' ? JSON.stringify(kind) : kind}`)
    .join('_');
}

export { formatBytes } from './sizes';

/** The form of a new index, as typed. */
export interface IndexForm {
  /** `{ field: 1 }`, `{ a: 1, b: -1 }`, `{ title: 'text' }`, `{ loc: '2dsphere' }`, `{ '$**': 1 }`. */
  keys: string;
  name: string;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  /** Seconds, for a TTL index. */
  ttl: string;
  /** The filter of a partial index. */
  partial: string;
  /** Other options of `createIndexes`, such as `{ collation: { locale: 'es' } }`. */
  options: string;
}

export function emptyIndexForm(): IndexForm {
  return {
    keys: '',
    name: '',
    unique: false,
    sparse: false,
    hidden: false,
    ttl: '',
    partial: '',
    options: '',
  };
}

function document(text: string, key: string): Plain {
  const value = parseValue(text);
  if (bsonType(value) !== 'Document') throw new WriteTextError(key);
  return value as Plain;
}

/** The keys and options to send, or a message key saying what to correct. */
export function indexRequest(form: IndexForm): { keys: Plain; options: Plain } {
  if (!form.keys.trim()) throw new WriteTextError('mongo.indexKeys');
  const keys = document(form.keys, 'mongo.indexKeys');
  if (!Object.keys(keys).length) throw new WriteTextError('mongo.indexKeys');
  const options: Plain = form.options.trim() ? document(form.options, 'mongo.notDocument') : {};
  if (form.name.trim()) options['name'] = form.name.trim();
  if (form.unique) options['unique'] = true;
  if (form.sparse) options['sparse'] = true;
  if (form.hidden) options['hidden'] = true;
  const ttl = form.ttl.trim();
  if (ttl) {
    if (!/^\d+$/.test(ttl) || !Number.isSafeInteger(Number(ttl)))
      throw new WriteTextError('mongo.notCount');
    options['expireAfterSeconds'] = Number(ttl);
  }
  if (form.partial.trim())
    options['partialFilterExpression'] = document(form.partial, 'mongo.notDocument');
  return { keys, options };
}

/** The profiler of a database: 0 off, 1 operations slower than `slowms`, 2 all. */
export interface ProfileStatus {
  level: number;
  slowms: number;
  sampleRate?: number;
}

export const PROFILE_LEVELS = [0, 1, 2] as const;

/** An operation the profiler recorded. */
export interface ProfileEntry {
  op: string;
  ns: string;
  millis: number;
  ts?: string;
  planSummary?: string;
  docsExamined?: number;
  keysExamined?: number;
  returned?: number;
  /** The command, in canonical Extended JSON. */
  command?: Plain;
}

/** A recorded query that can be explained again: a `find` or an aggregation, and where. */
export interface Explainable {
  database: string;
  collection: string;
  query?: BuiltQuery;
  pipeline?: Plain[];
}

/** The query of a recorded `find` or `aggregate`, or nothing for other operations. */
export function explainable(entry: ProfileEntry): Explainable | undefined {
  const command = entry.command;
  if (!command) return undefined;
  const dot = entry.ns.indexOf('.');
  const database =
    typeof command['$db'] === 'string' ? command['$db'] : dot > 0 ? entry.ns.slice(0, dot) : '';
  const number = (value: unknown) => {
    const plain = relaxed(value);
    return typeof plain === 'number' && plain > 0 ? plain : undefined;
  };
  const object = (value: unknown) => (isPlain(value) ? value : undefined);
  if (typeof command['find'] === 'string' && database) {
    const query: BuiltQuery = {};
    for (const field of ['filter', 'projection', 'sort', 'collation'] as const) {
      const value = object(command[field]);
      if (value && Object.keys(value).length) query[field] = value;
    }
    const hint = command['hint'];
    if (typeof hint === 'string' || isPlain(hint)) query.hint = hint;
    const skip = number(command['skip']);
    const limit = number(command['limit']);
    if (skip) query.skip = skip;
    if (limit) query.limit = limit;
    return { database, collection: command['find'], query };
  }
  if (typeof command['aggregate'] === 'string' && Array.isArray(command['pipeline']) && database) {
    const pipeline = command['pipeline'].filter(isPlain);
    // A pipeline that writes is not explained: measuring it would write.
    if (pipeline.some((stage) => '$out' in stage || '$merge' in stage)) return undefined;
    return { database, collection: command['aggregate'], pipeline };
  }
  return undefined;
}
