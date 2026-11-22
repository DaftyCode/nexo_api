/**
 * Code that runs a SQL statement (DB-33): a whole program in Node.js, Python, Java, C#, Go,
 * Rust, PHP or Ruby with the usual library of the engine, or its command line, with the
 * statement as a well-escaped string and its parameters bound (never pasted into the text).
 * The connection comes from the `DATABASE_URL` environment variable: its address and
 * password stay in Nexo. Also the statement alone as a string of a language, and back.
 */
import { cliProgram, shellString } from './sql-codegen/cli';
import { CodeInput, SqlCodeLanguage, SqlCodeQuery, familyOf } from './sql-codegen/common';
import { nodeProgram, phpProgram, pythonProgram, rubyProgram } from './sql-codegen/dynamic';
import { literal } from './sql-codegen/strings';
import { csharpProgram, goProgram, javaProgram, rustProgram } from './sql-codegen/typed';

export { SqlCodegenError, type SqlCodeLanguage, type SqlCodeQuery } from './sql-codegen/common';
export { pasteFromCode } from './sql-codegen/strings';

/** The languages offered, with the file a program is saved as. */
export const SQL_CODE_LANGUAGES: readonly { id: SqlCodeLanguage; label: string; file: string }[] = [
  { id: 'node', label: 'Node.js', file: 'query.mjs' },
  { id: 'python', label: 'Python', file: 'query.py' },
  { id: 'java', label: 'Java (JDBC)', file: 'Query.java' },
  { id: 'csharp', label: 'C# (ADO.NET)', file: 'Program.cs' },
  { id: 'go', label: 'Go', file: 'main.go' },
  { id: 'rust', label: 'Rust', file: 'main.rs' },
  { id: 'php', label: 'PHP (PDO)', file: 'query.php' },
  { id: 'ruby', label: 'Ruby', file: 'query.rb' },
  { id: 'cli', label: 'db.code.cli', file: 'query.sh' },
];

const PROGRAMS: Record<SqlCodeLanguage, (input: CodeInput) => string> = {
  node: nodeProgram,
  python: pythonProgram,
  java: javaProgram,
  csharp: csharpProgram,
  go: goProgram,
  rust: rustProgram,
  php: phpProgram,
  ruby: rubyProgram,
  cli: cliProgram,
};

/** A whole program that runs the statement and prints what it reads or changes. */
export function generateSqlCode(language: SqlCodeLanguage, query: SqlCodeQuery): string {
  const input: CodeInput = {
    family: familyOf(query.engine),
    sql: query.sql.trim(),
    values: query.values ?? {},
  };
  return PROGRAMS[language](input);
}

/** The statement alone as a string of the language (DBeaver's «Copy as source code»). */
export function copyAsString(language: SqlCodeLanguage, sql: string): string {
  return language === 'cli' ? shellString(sql) : literal(language, sql);
}
