/**
 * What the SQL editor suggests where the cursor is, as DBeaver does: tables after `FROM`,
 * `JOIN`, `INTO` and `UPDATE`; the columns of `alias.`; the columns of the tables of the
 * statement elsewhere; the condition of the foreign key after `JOIN … ON`; and `SELECT *`
 * expanded. Nothing inside a string or a comment. A pure function over the statement and
 * what is known of the schema.
 */

/** A table or view the editor knows, with what was read of it. */
export interface SchemaTable {
  name: string;
  schema?: string;
  kind: 'table' | 'view';
  columns?: readonly { name: string; type: string }[];
  /** Its foreign keys: its columns and the table and columns they point to. */
  keys?: readonly { columns: readonly string[]; table: string; referenced: readonly string[] }[];
}

/** A table named in the statement, with its alias. */
export interface TableRef {
  name: string;
  schema?: string;
  alias?: string;
}

export type CompletionContext =
  | { kind: 'none' }
  | { kind: 'tables'; from: number }
  | { kind: 'columns'; of: TableRef[]; from: number }
  | { kind: 'join'; tables: TableRef[]; joined: TableRef; from: number }
  | { kind: 'star'; tables: TableRef[]; from: number }
  | { kind: 'any'; tables: TableRef[]; from: number };

const TABLE_WORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);
const CLAUSE_WORDS = new Set([
  'SELECT',
  'WHERE',
  'AND',
  'OR',
  'ON',
  'BY',
  'SET',
  'HAVING',
  'NOT',
  'WHEN',
  'THEN',
  'ELSE',
  'CASE',
  'IN',
  'RETURNING',
  'VALUES',
]);
const NOT_ALIAS = new Set([
  'WHERE',
  'ON',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'FULL',
  'CROSS',
  'GROUP',
  'ORDER',
  'LIMIT',
  'SET',
  'USING',
  'HAVING',
  'UNION',
  'VALUES',
  'NATURAL',
  'OFFSET',
  'FETCH',
  'WINDOW',
]);

interface Token {
  text: string;
  start: number;
  /** A name or keyword, bare or quoted. */
  word?: string;
}

/** The tokens of a statement up to `end`; `undefined` when `end` is inside a string or a comment. */
function tokens(sql: string, end: number): Token[] | undefined {
  const found: Token[] = [];
  let at = 0;
  while (at < end) {
    const rest = sql.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    if (rest.startsWith('--')) {
      const line = rest.indexOf('\n');
      if (line < 0 || at + line >= end) return undefined;
      at += line;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/');
      if (close < 0 || at + close + 2 > end) return undefined;
      at += close + 2;
      continue;
    }
    if (rest[0] === "'") {
      const close = /^'(?:[^']|'')*'/.exec(rest);
      if (!close || at + close[0].length > end) return undefined;
      found.push({ text: close[0], start: at });
      at += close[0].length;
      continue;
    }
    const quoted = /^(?:"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])/.exec(rest);
    if (quoted) {
      found.push({ text: quoted[0], start: at, word: quoted[0].slice(1, -1) });
      at += quoted[0].length;
      continue;
    }
    const word = /^[A-Za-z_][\w$]*/.exec(rest);
    if (word) {
      found.push({ text: word[0], start: at, word: word[0] });
      at += word[0].length;
      continue;
    }
    found.push({ text: rest[0], start: at });
    at += 1;
  }
  return found;
}

const upper = (token: Token | undefined) => token?.word?.toUpperCase() ?? token?.text ?? '';

/** A name at `index`, maybe `schema.name`: the ref and the index after it. */
function nameAt(list: readonly Token[], index: number): [TableRef, number] | undefined {
  const first = list[index];
  if (!first?.word) return undefined;
  if (list[index + 1]?.text === '.' && list[index + 2]?.word)
    return [{ schema: first.word, name: list[index + 2].word! }, index + 3];
  return [{ name: first.word }, index + 1];
}

/** The tables the statement names after `FROM`, `JOIN` and `UPDATE`, with their aliases. */
export function tablesOf(sql: string): TableRef[] {
  const list = tokens(sql, sql.length) ?? [];
  const found: TableRef[] = [];
  for (let index = 0; index < list.length; index++) {
    const word = upper(list[index]);
    if (!(word === 'FROM' || word === 'JOIN' || word === 'UPDATE' || word === 'INTO')) continue;
    let at = index + 1;
    while (at < list.length) {
      const named = nameAt(list, at);
      if (!named) break;
      const [ref, next] = named;
      at = next;
      if (upper(list[at]) === 'AS') at++;
      if (list[at]?.word && !NOT_ALIAS.has(upper(list[at]))) ref.alias = list[at++].word;
      found.push(ref);
      if (word !== 'FROM' || list[at]?.text !== ',') break;
      at++;
    }
  }
  return found;
}

/** What to suggest at `cursor` of `sql` (one statement). */
export function completionContext(sql: string, cursor: number): CompletionContext {
  const list = tokens(sql, cursor);
  if (!list) return { kind: 'none' };
  const tables = tablesOf(sql);
  // The word being typed, if the cursor ends one.
  const last = list.at(-1);
  const typing = last?.word !== undefined && last.start + last.text.length === cursor;
  const from = typing ? last!.start : cursor;
  const before = typing ? list.slice(0, -1) : list;
  const previous = before.at(-1);
  if (previous?.text === '.' && before.at(-2)?.word) {
    const owner = before.at(-2)!.word!.toLowerCase();
    const of = tables.filter(
      (table) => table.alias?.toLowerCase() === owner || table.name.toLowerCase() === owner,
    );
    return { kind: 'columns', of: of.length ? of : [{ name: before.at(-2)!.word! }], from };
  }
  if (previous?.text === '*' && upper(before.at(-2)) === 'SELECT')
    return { kind: 'star', tables, from: previous.start };
  const word = upper(previous);
  if (TABLE_WORDS.has(word) || (previous?.text === ',' && inFrom(before)))
    return { kind: 'tables', from };
  if (word === 'ON') {
    const joined = joinedBefore(before);
    if (joined) return { kind: 'join', tables, joined, from };
  }
  if (
    CLAUSE_WORDS.has(word) ||
    previous?.text === ',' ||
    previous?.text === '(' ||
    isOperator(previous)
  )
    return { kind: 'any', tables, from };
  return typing ? { kind: 'any', tables, from } : { kind: 'none' };
}

function isOperator(token: Token | undefined) {
  return !!token && /^[=<>!+\-*/%|]$/.test(token.text);
}
/** Whether the last clause opened is `FROM` (a list of tables goes on after a comma). */
function inFrom(list: readonly Token[]): boolean {
  for (let index = list.length - 1; index >= 0; index--) {
    const word = upper(list[index]);
    if (word === 'FROM') return true;
    if (CLAUSE_WORDS.has(word) || NOT_ALIAS.has(word)) return false;
  }
  return false;
}
/** The table of `JOIN table [AS] [alias] ON`, just before the cursor. */
function joinedBefore(list: readonly Token[]): TableRef | undefined {
  for (let index = list.length - 2; index >= 0; index--) {
    if (upper(list[index]) !== 'JOIN') continue;
    const named = nameAt(list, index + 1);
    if (!named) return undefined;
    const [ref, next] = named;
    let at = next;
    if (upper(list[at]) === 'AS') at++;
    if (list[at]?.word && upper(list[at]) !== 'ON') ref.alias = list[at].word;
    return ref;
  }
  return undefined;
}
