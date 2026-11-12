/**
 * The MongoDB shell of the explorer: what a command gave, the words suggested while one is
 * typed, the confirmation a destructive command asks for, and the history of commands.
 */

/** What a command gave, as the engine answers it. */
export interface ShellAnswer {
  /** The database the next command starts in (`use` changes it). */
  database: string;
  /** `documents` for a cursor's documents, `value` for anything else, `none` for nothing. */
  kind: 'documents' | 'value' | 'none';
  /** In canonical Extended JSON. */
  value?: unknown;
  /** What `print`, `printjson` and `console.log` wrote, one array of texts per call. */
  logs: string[][];
  elapsedMs: number;
}

/** A command run in the shell, with what it gave or why it failed. */
export interface ShellEntry {
  command: string;
  database: string;
  answer?: ShellAnswer;
  error?: string;
}

/** Commands kept in the history of a connection. */
export const SHELL_HISTORY = 50;

/** Methods of a collection the shell knows. */
export const COLLECTION_METHODS = [
  'find',
  'findOne',
  'countDocuments',
  'estimatedDocumentCount',
  'aggregate',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'getIndexes',
  'createIndex',
  'drop',
];
/** Methods of `db` the shell knows. */
export const DATABASE_METHODS = [
  'getName',
  'getCollectionNames',
  'listCollections',
  'getSiblingDB',
  'getCollection',
  'dropDatabase',
];

/** The words suggested in the shell: commands, `db` methods, collections and their methods. */
export function shellWords(collections: readonly string[]): string[] {
  const words = ['show dbs', 'show collections', 'use', 'print', 'printjson'];
  words.push(...DATABASE_METHODS.map((method) => `db.${method}`));
  for (const name of collections) {
    const path = /^[A-Za-z_$][\w$]*$/.test(name) ? `db.${name}` : `db.getCollection('${name}')`;
    words.push(path, ...COLLECTION_METHODS.map((method) => `${path}.${method}`));
  }
  return words;
}

/** The name a destructive command needs typed, from the refusal of the backend. */
export function confirmationAsked(
  message: string,
): { what: 'collection' | 'database'; name: string } | undefined {
  const found = /^Type the name of the (collection|database) to confirm: (.+)$/.exec(
    message.trim(),
  );
  return found ? { what: found[1] as 'collection' | 'database', name: found[2] } : undefined;
}

/** The history with a command added last; a repeat of the last one is not added twice. */
export function remember(history: readonly string[], command: string): string[] {
  const text = command.trim();
  if (!text || history.at(-1) === text) return [...history];
  return [...history, text].slice(-SHELL_HISTORY);
}

/** A stored history, read defensively. */
export function readHistory(stored: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(stored ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(-SHELL_HISTORY)
      : [];
  } catch {
    return [];
  }
}
