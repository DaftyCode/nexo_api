/**
 * A comparison of two collections as it is saved in the workspace, to run it again: both
 * sides, the filter as typed, the key that pairs documents and the fields left out.
 */
import { isPlain } from './bson';

export interface CompareValue {
  /** The source: the id of its saved connection, its database and collection. */
  connection: string;
  database: string;
  collection: string;
  target: { connection: string; database: string; collection: string };
  /** Shell syntax, as typed; empty for every document. */
  filter: string;
  key: string;
  ignore: string[];
  /** Syncing deletes what only the target has. */
  remove: boolean;
}

export function compareValue(value: unknown): CompareValue {
  const stored = isPlain(value) ? value : {};
  const text = (source: Record<string, unknown>, key: string) =>
    typeof source[key] === 'string' ? (source[key] as string) : '';
  const target = isPlain(stored['target']) ? stored['target'] : {};
  return {
    connection: text(stored, 'connection'),
    database: text(stored, 'database'),
    collection: text(stored, 'collection'),
    target: {
      connection: text(target, 'connection'),
      database: text(target, 'database'),
      collection: text(target, 'collection'),
    },
    filter: text(stored, 'filter'),
    key: text(stored, 'key') || '_id',
    ignore: Array.isArray(stored['ignore'])
      ? stored['ignore'].filter((field): field is string => typeof field === 'string')
      : [],
    remove: stored['remove'] === true,
  };
}

/** Field names typed separated by commas. */
export function fieldList(text: string): string[] {
  return text
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}
