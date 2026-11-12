/**
 * Imports and exports of MongoDB collections: their formats, how CSV columns become fields,
 * and the transfers saved in a workspace to run them again.
 */
import { isPlain } from './bson';
import { QueryForm, emptyQueryForm } from './mongo-query';

export type { CsvColumn, ImportType } from './mongo-transfer/cells';
export { IMPORT_TYPES, cellText, typedValue } from './mongo-transfer/cells';
export {
  CsvReader,
  csvRecord,
  csvRow,
  documentFields,
  fieldValue,
  rowDocument,
} from './mongo-transfer/csv';
export { JsonDocumentsReader, jsonDocument } from './mongo-transfer/json';
export type { ReadDocument } from './mongo-transfer/json';
import type { CsvColumn } from './mongo-transfer/cells';

export type TransferFormat = 'json' | 'jsonl' | 'csv';
/** Extended JSON: canonical keeps every type; relaxed writes plain numbers and dates. */
export type JsonFlavour = 'canonical' | 'relaxed';
/** What an export reads: the whole collection, the query of the bar, or the page shown. */
export type ExportScope = 'collection' | 'query' | 'page';
/** How an import writes: inserts, replaces by some fields, or empties the collection first. */
export type ImportMode = 'insert' | 'upsert' | 'replace';

export const TRANSFER_FORMATS: readonly TransferFormat[] = ['json', 'jsonl', 'csv'];
export const EXTENSIONS: Record<TransferFormat, string> = {
  json: 'json',
  jsonl: 'jsonl',
  csv: 'csv',
};
export const MEDIA_TYPES: Record<TransferFormat, string> = {
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  csv: 'text/csv',
};

/** A transfer saved in the workspace, run again by hand. */
export interface TransferValue {
  direction: 'export' | 'import';
  connection: string;
  database: string;
  collection: string;
  format: TransferFormat;
  flavour: JsonFlavour;
  /** Export: what it reads (the query as typed), and the fields of a CSV in their order. */
  scope: ExportScope;
  query: QueryForm;
  fields: string[];
  /** Export: to a file, or copied to a collection of a saved connection. */
  destination: 'file' | 'collection';
  to: { connection: string; database: string; collection: string };
  /** Import: the columns of a CSV and how they are written. */
  columns: CsvColumn[];
  mode: ImportMode;
  key: string[];
  continueOnError: boolean;
}

export function emptyTransfer(
  direction: TransferValue['direction'],
  connection: string,
  database: string,
  collection: string,
): TransferValue {
  return {
    direction,
    connection,
    database,
    collection,
    format: 'json',
    flavour: 'canonical',
    scope: 'collection',
    query: emptyQueryForm(),
    fields: [],
    destination: 'file',
    to: { connection, database, collection: '' },
    columns: [],
    mode: 'insert',
    key: [],
    continueOnError: true,
  };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The text fields of `shape` found in a stored object. */
function fieldsOf<T extends object>(value: unknown, shape: T): T {
  const stored = isPlain(value) ? value : {};
  const read: Record<string, unknown> = { ...(shape as Record<string, unknown>) };
  for (const key of Object.keys(shape))
    if (typeof stored[key] === 'string') read[key] = stored[key];
  return read as T;
}

/** A stored transfer, with what is missing or unknown set to its default. */
export function transferValue(value: unknown): TransferValue {
  const stored = isPlain(value) ? value : {};
  const text = (key: string) => (typeof stored[key] === 'string' ? (stored[key] as string) : '');
  const base = emptyTransfer(
    oneOf(stored['direction'], ['export', 'import'], 'export'),
    text('connection'),
    text('database'),
    text('collection'),
  );
  return {
    ...base,
    format: oneOf(stored['format'], TRANSFER_FORMATS, 'json'),
    flavour: oneOf(stored['flavour'], ['canonical', 'relaxed'], 'canonical'),
    scope: oneOf(stored['scope'], ['collection', 'query', 'page'], 'collection'),
    query: fieldsOf(stored['query'], base.query),
    fields: texts(stored['fields']),
    destination: oneOf(stored['destination'], ['file', 'collection'], 'file'),
    to: fieldsOf(stored['to'], base.to),
    columns: (Array.isArray(stored['columns']) ? stored['columns'] : [])
      .filter(isPlain)
      .map((column) => ({
        column: String(column['column'] ?? ''),
        field: String(column['field'] ?? ''),
        type: String(column['type'] ?? 'auto') as CsvColumn['type'],
      })),
    mode: oneOf(stored['mode'], ['insert', 'upsert', 'replace'], 'insert'),
    key: texts(stored['key']),
    continueOnError: stored['continueOnError'] !== false,
  };
}

/** The format of a file by its name, or by its first character when the name says nothing. */
export function formatOf(name: string, firstCharacter = ''): TransferFormat {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  if (extension === 'csv' || extension === 'tsv') return 'csv';
  if (extension === 'jsonl' || extension === 'ndjson') return 'jsonl';
  if (extension === 'json') return 'json';
  return firstCharacter === '{' || firstCharacter === '[' ? 'json' : 'csv';
}

/** A file name for an export: the collection, the date and the extension of the format. */
export function exportName(collection: string, format: TransferFormat, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const safe = collection.replace(/[^\w.-]+/g, '_') || 'export';
  return `${safe}-${day}.${EXTENSIONS[format]}`;
}
