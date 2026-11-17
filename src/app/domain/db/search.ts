/**
 * What the database search finds, as DBeaver's «Search»: objects by name (or in their code),
 * a value in the data of tables, and text in the saved scripts and the history; and the
 * filter that opens a table's data on the rows where a value was found.
 */
import { QuoteStyle, quoteName } from './tree';

export interface ObjectHit {
  kind: string;
  schema?: string;
  table?: string;
  name: string;
  path: string[];
  inCode?: boolean;
}

export interface DataHit {
  schema?: string;
  table: string;
  path: string[];
  matched: string[];
  columns: string[];
  rows: unknown[][];
  more?: boolean;
}

/** A line of a saved script or of the history that holds the text. */
export interface ScriptHit {
  kind: 'script' | 'history';
  /** The script's id, or the history entry's. */
  id: string;
  name: string;
  connection: string;
  /** From 1. */
  line: number;
  /** Where the text starts in the whole script. */
  offset: number;
  excerpt: string;
  sql: string;
}

export interface SearchableScript {
  kind: 'script' | 'history';
  id: string;
  name: string;
  connection: string;
  sql: string;
}

/** Every line of the scripts that holds `text`, at most `max`. */
export function findInScripts(
  scripts: readonly SearchableScript[],
  text: string,
  caseSensitive: boolean,
  max = 200,
): ScriptHit[] {
  const needle = caseSensitive ? text : text.toLowerCase();
  if (!needle.trim()) return [];
  const hits: ScriptHit[] = [];
  for (const script of scripts) {
    let start = 0;
    script.sql.split('\n').forEach((line, at) => {
      const haystack = caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      if (column >= 0 && hits.length < max)
        hits.push({
          kind: script.kind,
          id: script.id,
          name: script.name,
          connection: script.connection,
          line: at + 1,
          offset: start + column,
          excerpt: line.trim().slice(0, 160),
          sql: script.sql,
        });
      start += line.length + 1;
    });
  }
  return hits;
}

/** How each engine reads any value as text, for the filter of the data. */
const TEXT_TYPES: Record<string, string> = {
  postgresql: 'text',
  mysql: 'CHAR',
  tsql: 'nvarchar(max)',
  sqlite: 'TEXT',
};

/**
 * The condition that keeps the rows where `text` was found in the columns `matched`, for
 * a table's «Data» tab: its wildcards and quotes taken literally.
 */
export function dataWhere(
  matched: readonly string[],
  text: string,
  style: QuoteStyle & { name: string },
): string {
  const tsql = style.name === 'tsql';
  let pattern = '%';
  for (const character of text.toLowerCase()) {
    if ('!%_'.includes(character) || (tsql && character === '[')) pattern += '!';
    pattern += character;
  }
  const literal = `'${(pattern + '%').replace(/'/g, "''")}'`;
  const type = TEXT_TYPES[style.name] ?? 'TEXT';
  return matched
    .map(
      (column) => `LOWER(CAST(${quoteName(column, style)} AS ${type})) LIKE ${literal} ESCAPE '!'`,
    )
    .join(' OR ');
}
