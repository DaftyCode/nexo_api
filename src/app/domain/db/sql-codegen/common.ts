/**
 * What every program of a statement shares (DB-33): the engine's family, the values of its
 * parameters as the person last typed them, and the statement with the markers of a
 * library, its values in the order they bind.
 */
import { markParameters, parametersOf } from '../sql-params';

/** The engines with programs, by the library each language uses for them. */
export type SqlFamily = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'duckdb';
export type SqlCodeLanguage =
  'node' | 'python' | 'java' | 'csharp' | 'go' | 'rust' | 'php' | 'ruby' | 'cli';
/** A parameter's value as a program writes it. */
export type CodeValue = null | number | boolean | string;

/** What the code runs: a statement of an engine, with `:name` (or `?`) parameters. */
export interface SqlCodeQuery {
  engine: string;
  sql: string;
  /** The values typed for its parameters, by name (`1`, `2`… for `?`). */
  values?: Readonly<Record<string, string>>;
}
export interface CodeInput {
  family: SqlFamily;
  sql: string;
  values: Readonly<Record<string, string>>;
}

/** Why a program cannot be written: a message key and its parameters. */
export class SqlCodegenError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, string> = {},
  ) {
    super(key);
  }
}

export function familyOf(engine: string): SqlFamily {
  switch (engine) {
    case 'postgres':
    case 'postgresql':
      return 'postgres';
    case 'mysql':
    case 'mariadb':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'mssql':
    case 'sqlserver':
      return 'mssql';
    case 'files':
    case 'duckdb':
      return 'duckdb';
    default:
      throw new SqlCodegenError('db.code.noEngine', { v0: engine });
  }
}

/** A typed value as a program writes it: a number, a boolean, NULL or text. */
export function codeValue(text: string | undefined): CodeValue {
  if (text === undefined || text === '' || /^null$/i.test(text)) return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isSafeInteger(number) || !Number.isInteger(number)) return number;
  }
  return text;
}

/** How a library writes a parameter. */
export type Marker = 'dollar' | 'question' | 'percent' | 'at' | 'atUpper' | 'colon';
const MARKERS: Record<Marker, { marker: (n: number) => string; reuse: boolean }> = {
  dollar: { marker: (n) => `$${n}`, reuse: true },
  question: { marker: () => '?', reuse: false },
  percent: { marker: () => '%s', reuse: false },
  at: { marker: (n) => `@p${n}`, reuse: true },
  atUpper: { marker: (n) => `@P${n}`, reuse: true },
  colon: { marker: (n) => `:${n}`, reuse: true },
};

/** The engines whose editor binds a `?` of the statement too. */
const QUESTION: readonly SqlFamily[] = ['mysql', 'sqlite', 'duckdb'];

/**
 * The statement with the markers of a library, and its values in the order they bind;
 * `written` writes each marker instead, binding as `marker` does.
 */
export function bound(
  input: CodeInput,
  marker: Marker,
  written?: (position: number) => string,
): { sql: string; values: CodeValue[] } {
  const question = QUESTION.includes(input.family);
  const found = parametersOf(input.sql, question);
  const named = Object.fromEntries(found.names.map((name) => [name, input.values[name]]));
  const positional = Array.from({ length: found.positional }, (_, at) => input.values[`${at + 1}`]);
  // With `%s` a `%` of the statement is written twice, when it has parameters.
  const some = found.names.length > 0 || found.positional > 0;
  const text = marker === 'percent' && some ? input.sql.replace(/%/g, '%%') : input.sql;
  const how = MARKERS[marker];
  const marked = markParameters(text, question, named, positional, {
    marker: written ?? how.marker,
    reuse: how.reuse,
  });
  return {
    sql: marked.sql,
    values: marked.params.map((value) => codeValue(value as string | undefined)),
  };
}

/** Lines of a program, ending with a new line. */
export const lines = (...all: string[]) => `${all.join('\n')}\n`;
