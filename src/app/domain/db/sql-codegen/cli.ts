/**
 * The statement with the command line of its engine (DB-33): `psql` with its variables,
 * MySQL Shell with user variables, `sqlite3` with `.parameter set`, `sqlcmd` with
 * `sp_executesql` and `duckdb` with `PREPARE`. The statement goes in a quoted here-document,
 * so the shell changes nothing of it, and the connection comes from the environment.
 */
import { CodeInput, CodeValue, bound, lines } from './common';

/** A shell word in single quotes. */
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
/** An SQL literal; MySQL also reads backslashes as escapes. */
function sqlLiteral(value: CodeValue, family: CodeInput['family']): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean')
    return family === 'mssql' ? (value ? '1' : '0') : String(value).toUpperCase();
  if (typeof value === 'number') return String(value);
  const text = family === 'mysql' ? value.replace(/\\/g, '\\\\') : value;
  return `${family === 'mssql' ? 'N' : ''}'${text.replace(/'/g, "''")}'`;
}
/** The statement ending with one `;`. */
const ended = (sql: string) => `${sql.trimEnd().replace(/;+$/, '')};`;
/** A here-document delimiter that is not a line of the text. */
function delimiter(text: string): string {
  let name = 'SQL';
  while (text.split('\n').some((line) => line.trim() === name)) name += '_END';
  return name;
}
const document = (command: string, body: string) => {
  const end = delimiter(body);
  return [`${command} <<'${end}'`, body, end];
};
const T_SQL_TYPES = (value: CodeValue) =>
  value === null || typeof value === 'string'
    ? 'nvarchar(max)'
    : typeof value === 'boolean'
      ? 'bit'
      : Number.isInteger(value)
        ? 'bigint'
        : 'float';

export function cliProgram(input: CodeInput): string {
  switch (input.family) {
    case 'postgres': {
      const { values } = bound(input, 'dollar');
      const { sql } = bound(input, 'dollar', (n) => (values[n - 1] === null ? 'NULL' : `:'p${n}'`));
      const variables = values
        .map((value, at) => (value === null ? '' : ` -v p${at + 1}=${shellWord(String(value))}`))
        .join('');
      return lines(
        '# psql connects with DATABASE_URL; each value is a variable that psql quotes.',
        ...document(`psql "$DATABASE_URL"${variables}`, ended(sql)),
      );
    }
    case 'mysql': {
      const { values } = bound(input, 'dollar');
      const { sql } = bound(input, 'dollar', (n) => `@p${n}`);
      return lines(
        '# MySQL Shell connects with DATABASE_URL (mysql://user@host/database).',
        ...document(
          'mysqlsh "$DATABASE_URL" --sql',
          [
            ...values.map((value, at) => `SET @p${at + 1} = ${sqlLiteral(value, 'mysql')};`),
            ended(sql),
          ].join('\n'),
        ),
      );
    }
    case 'sqlite': {
      const { values } = bound(input, 'dollar');
      const { sql } = bound(input, 'dollar', (n) => `:p${n}`);
      const set = values.map((value, at) => {
        const literal = sqlLiteral(value, 'sqlite');
        const quoted =
          typeof value === 'string'
            ? `"${literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
            : literal;
        return `.parameter set :p${at + 1} ${quoted}`;
      });
      return lines(
        '# DATABASE_URL is the path of the file.',
        ...document('sqlite3 "$DATABASE_URL"', [...set, ended(sql)].join('\n')),
      );
    }
    case 'mssql': {
      const { sql, values } = bound(input, 'at');
      const call = values.length
        ? [
            `EXEC sp_executesql ${sqlLiteral(sql, 'mssql')},`,
            `  N'${values.map((value, at) => `@p${at + 1} ${T_SQL_TYPES(value)}`).join(', ')}',`,
            `  ${values.map((value, at) => `@p${at + 1} = ${sqlLiteral(value, 'mssql')}`).join(', ')};`,
          ].join('\n')
        : ended(sql);
      return lines(
        '# sqlcmd reads SQLCMDSERVER, SQLCMDDBNAME, SQLCMDUSER and SQLCMDPASSWORD from the environment.',
        ...document('sqlcmd', `${call}\nGO`),
      );
    }
    case 'duckdb': {
      const { sql, values } = bound(input, 'dollar');
      const body = values.length
        ? `PREPARE query AS ${ended(sql)}\nEXECUTE query(${values.map((value) => sqlLiteral(value, 'duckdb')).join(', ')});`
        : ended(sql);
      return lines(
        '# DATABASE_URL is the path of the database or of a folder of files.',
        ...document('duckdb "$DATABASE_URL"', body),
      );
    }
  }
}

/** The statement as a single-quoted word of the shell. */
export const shellString = shellWord;
