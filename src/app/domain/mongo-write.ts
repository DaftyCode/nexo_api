/**
 * Writes on MongoDB documents as the explorer builds them: a field edited with `$set` (or
 * removed with `$unset`) instead of rewriting the document, documents typed in the shell's
 * syntax, and the write concern chosen for an operation.
 */
import { bsonType } from './bson';
import { QuerySyntaxError, shellToExtendedJson } from './mongo-query';

type Plain = Record<string, unknown>;
export type Path = readonly (string | number)[];

/** A field's path as MongoDB writes it: `customer.address.city`, `items.1.qty`. */
export function dottedPath(path: Path): string {
  return path.map(String).join('.');
}

/** The filter of one document: its `_id`, with its type. */
export function idFilter(document: Plain): Plain {
  if (!('_id' in document)) throw new Error('The document has no _id');
  return { _id: document['_id'] };
}

/** Sets one field (keeping the others and their types as they are). */
export function setField(path: Path, value: unknown): Plain {
  if (!path.length) throw new Error('Choose a field');
  if (path[0] === '_id') throw new Error('The _id of a document cannot change');
  return { $set: { [dottedPath(path)]: value } };
}

export function unsetField(path: Path): Plain {
  if (!path.length || path[0] === '_id') throw new Error('The _id of a document cannot change');
  return { $unset: { [dottedPath(path)]: '' } };
}

/** A copy to insert as a new document: without its `_id`, so a new one is chosen. */
export function duplicate(document: Plain): Plain {
  const { _id: _, ...copy } = document;
  return copy;
}

/** Why typed text cannot be written, as a message key with its values. */
export class WriteTextError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(key);
  }
}

/** A value typed in the shell's syntax or Extended JSON. */
export function parseValue(text: string): unknown {
  try {
    return shellToExtendedJson(text);
  } catch (error) {
    if (!(error instanceof QuerySyntaxError)) throw error;
    throw new WriteTextError('mongo.syntax', {
      v0: error.reason,
      v1: error.line,
      v2: error.column,
      v3: error.detail,
    });
  }
}

/** One document, or several in an array. */
export function parseDocuments(text: string): Plain[] {
  const value = parseValue(text);
  const documents = Array.isArray(value) ? value : [value];
  if (!documents.length || documents.some((item) => bsonType(item) !== 'Document'))
    throw new WriteTextError('mongo.notDocuments');
  return documents as Plain[];
}

/** An update document (`{$set: …}`) or a pipeline (`[{$set: …}]`). */
export function parseUpdate(text: string): Plain | Plain[] {
  const value = parseValue(text);
  const stages = Array.isArray(value) ? value : [value];
  const valid =
    stages.length > 0 &&
    stages.every(
      (stage) =>
        bsonType(stage) === 'Document' &&
        Object.keys(stage as Plain).length > 0 &&
        Object.keys(stage as Plain).every((key) => key.startsWith('$')),
    );
  if (!valid) throw new WriteTextError('mongo.notUpdate');
  return value as Plain | Plain[];
}

export type WriteConcernChoice = '' | 'majority' | '1';
export const WRITE_CONCERNS: readonly WriteConcernChoice[] = ['', 'majority', '1'];

/** The write concern of an operation; none keeps the connection's. */
export function writeConcern(choice: WriteConcernChoice): { w: string | number } | undefined {
  if (choice === 'majority') return { w: 'majority' };
  if (choice === '1') return { w: 1 };
  return undefined;
}

/** Options of a new collection, as typed in the form. */
export interface CollectionForm {
  capped: boolean;
  size: string;
  max: string;
  timeField: string;
  metaField: string;
  granularity: string;
  validator: string;
}

export function emptyCollectionForm(): CollectionForm {
  return {
    capped: false,
    size: '',
    max: '',
    timeField: '',
    metaField: '',
    granularity: '',
    validator: '',
  };
}

/** The options of `create`, or a message key saying what is missing. */
export function collectionOptions(form: CollectionForm): Plain {
  const options: Plain = {};
  const count = (text: string) => {
    const value = Number(text.trim());
    if (!/^\d+$/.test(text.trim()) || !value) throw new WriteTextError('mongo.notCount');
    return value;
  };
  if (form.capped) {
    if (form.timeField.trim()) throw new WriteTextError('mongo.cappedTimeSeries');
    options['capped'] = true;
    options['size'] = count(form.size);
    if (form.max.trim()) options['max'] = count(form.max);
  }
  if (form.timeField.trim()) {
    const timeseries: Plain = { timeField: form.timeField.trim() };
    if (form.metaField.trim()) timeseries['metaField'] = form.metaField.trim();
    if (form.granularity) timeseries['granularity'] = form.granularity;
    options['timeseries'] = timeseries;
  }
  if (form.validator.trim()) {
    const validator = parseValue(form.validator);
    if (bsonType(validator) !== 'Document') throw new WriteTextError('mongo.notDocument');
    options['validator'] = validator;
  }
  return options;
}

/** A recorded write, as the workspace keeps it. */
export interface DatabaseChangeValue {
  connection: string;
  database: string;
  collection: string;
  operation: string;
  matched: number;
  modified: number;
  deleted: number;
  inserted: number;
  /** The documents before and after: empty when it cannot be undone. */
  changes: unknown[];
}

export function changeValue(value: unknown): DatabaseChangeValue {
  const stored = (value && typeof value === 'object' ? value : {}) as Plain;
  const text = (key: string) => (typeof stored[key] === 'string' ? (stored[key] as string) : '');
  const number = (key: string) => (typeof stored[key] === 'number' ? (stored[key] as number) : 0);
  return {
    connection: text('connection'),
    database: text('database'),
    collection: text('collection'),
    operation: text('operation'),
    matched: number('matched'),
    modified: number('modified'),
    deleted: number('deleted'),
    inserted: number('inserted'),
    changes: Array.isArray(stored['changes']) ? (stored['changes'] as unknown[]) : [],
  };
}
