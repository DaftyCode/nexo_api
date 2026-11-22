import { describe, expect, it } from 'vitest';
import {
  SQL_CODE_LANGUAGES,
  SqlCodegenError,
  copyAsString,
  generateSqlCode,
  pasteFromCode,
} from './sql-codegen';
import { codeValue } from './sql-codegen/common';
import { literal, valueLiteral } from './sql-codegen/strings';

const ENGINES = ['postgres', 'mysql', 'sqlite', 'mssql', 'files'];
const LANGUAGES = SQL_CODE_LANGUAGES.map((language) => language.id);
const HARD = `SELECT 'it''s', "col" AS "a\\b", \`x\`, '%' AS pct
FROM t -- \${not} a template
WHERE id = :id AND name = :name AND id <> :id`;
const VALUES = { id: '42', name: 'O\'Brien \\ "q"' };

/** Every program that can be written, with what it is for. */
function programs() {
  const all: { language: string; engine: string; code: string }[] = [];
  for (const language of LANGUAGES)
    for (const engine of ENGINES) {
      try {
        all.push({
          language,
          engine,
          code: generateSqlCode(language, { engine, sql: HARD, values: VALUES }),
        });
      } catch (error) {
        expect(error).toBeInstanceOf(SqlCodegenError);
      }
    }
  return all;
}

describe('code that runs a SQL statement', () => {
  it('reads the connection from DATABASE_URL and never writes the statement with its values', () => {
    const all = programs();
    // PHP has no usual library for DuckDB, Ruby none for SQL Server nor DuckDB.
    expect(all).toHaveLength(LANGUAGES.length * ENGINES.length - 3);
    for (const { language, engine, code } of all) {
      const where = `${language} ${engine}`;
      expect(code, where).toMatch(/DATABASE_URL|SQLCMD/);
      expect(code, where).not.toContain(':name');
      expect(code, where).not.toMatch(/postgres:\/\/|password=['"]/i);
      // The value travels as a parameter, written once per place it binds at most.
      expect(code.split('42').length - 1, where).toBeLessThanOrEqual(2);
    }
  });

  it('writes the markers of each library', () => {
    const sql = 'SELECT * FROM t WHERE a = :a AND b = :b AND c = :a';
    const code = (language: (typeof LANGUAGES)[number], engine: string) =>
      generateSqlCode(language, { engine, sql, values: { a: '1', b: 'x' } });
    expect(code('node', 'postgres')).toContain('a = $1 AND b = $2 AND c = $1');
    expect(code('node', 'postgres')).toContain("[1, 'x']");
    expect(code('node', 'mysql')).toContain("a = ? AND b = ? AND c = ?';");
    expect(code('node', 'mysql')).toContain("execute(sql, [1, 'x', 1])");
    expect(code('node', 'mssql')).toContain("request.input('p2', 'x');");
    expect(code('node', 'mssql')).toContain('c = @p1');
    expect(code('python', 'postgres')).toContain('a = %s AND b = %s AND c = %s", [1, "x", 1])');
    expect(code('python', 'sqlite')).toContain('a = ? AND b = ? AND c = ?", [1, "x", 1])');
    expect(code('java', 'postgres')).toContain('statement.setObject(3, 1);');
    expect(code('csharp', 'mssql')).toContain('parameter.ParameterName = "@p2";');
    expect(code('csharp', 'files')).toContain('parameter.ParameterName = "2";');
    expect(code('go', 'mssql')).toContain('c = @p1"');
    expect(code('go', 'postgres')).toContain('db.Query(query, 1, "x")');
    expect(code('rust', 'mssql')).toContain('c = @P1"');
    expect(code('rust', 'postgres')).toContain('&[&1i64, &"x"]');
    expect(code('rust', 'mysql')).toContain('(1i64, "x", 1i64)');
    expect(code('php', 'mysql')).toContain("$statement->execute([1, 'x', 1]);");
    expect(code('ruby', 'postgres')).toContain("[1, 'x'])");
    expect(code('cli', 'postgres')).toContain("psql \"$DATABASE_URL\" -v p1='1' -v p2='x'");
    expect(code('cli', 'postgres')).toContain("c = :'p1';");
    expect(code('cli', 'mysql')).toContain("SET @p2 = 'x';");
    expect(code('cli', 'sqlite')).toContain(`.parameter set :p2 "'x'"`);
    expect(code('cli', 'mssql')).toContain("N'@p1 bigint, @p2 nvarchar(max)'");
    expect(code('cli', 'files')).toContain('EXECUTE query(1, ');
    // A `?` of PostgreSQL is an operator, not a parameter.
    expect(
      generateSqlCode('node', { engine: 'postgres', sql: "SELECT '{}'::jsonb ? 'a'" }),
    ).toContain("::jsonb ? \\'a\\'");
  });

  it('writes a % twice for the libraries that format with %s, only with parameters', () => {
    const like = (values?: Record<string, string>) =>
      generateSqlCode('python', {
        engine: 'postgres',
        sql: "SELECT 1 WHERE 'a' LIKE '%' || :x",
        values,
      });
    expect(like({ x: 'a' })).toContain("LIKE '%%' || %s");
    expect(generateSqlCode('python', { engine: 'postgres', sql: "SELECT '%'" })).toContain(
      `cursor.execute("SELECT '%'")`,
    );
  });

  it('escapes quotes, backslashes and new lines in every language, and reads them back', () => {
    const text = 'SELECT \'a\' AS "b", `c` -- \\ ${d}\nFROM t\r\n\tWHERE x = "#"';
    for (const language of LANGUAGES) {
      const written = copyAsString(language, text);
      if (language !== 'cli') expect(pasteFromCode(written), language).toBe(text);
    }
    expect(copyAsString('cli', "it's")).toBe(`'it'\\''s'`);
    expect(literal('node', 'a`b${c}\\', true)).toBe('`a\\`b\\${c}\\\\`');
    expect(literal('python', 'a"b\n', true)).toBe('"""a\\"b\n"""');
    expect(literal('java', 'a\nb', true)).toBe('"a\\n" +\n    "b"');
    expect(literal('csharp', 'a"b\nc', true)).toBe('@"a""b\nc"');
    expect(literal('go', 'a`b\nc', true)).toBe('"a`b\\nc"');
    expect(literal('go', 'a\nb', true)).toBe('`a\nb`');
    expect(literal('rust', 'a"#b\nc', true)).toBe('r##"a"#b\nc"##');
    expect(literal('rust', 'a"\u0001', false)).toBe('"a\\"\\u{0001}"');
    expect(literal('php', "it's \\", true)).toBe("'it\\'s \\\\'");
  });

  it('pastes the text of literals joined from code, or the text as it is', () => {
    expect(pasteFromCode('String sql = "SELECT *\\n" +\n  "FROM t";')).toBe('SELECT *\nFROM t');
    expect(pasteFromCode("$sql = 'SELECT ' . 'it\\'s';")).toBe("SELECT it's");
    expect(pasteFromCode('query = ("SELECT 1 "\n  "FROM dual")')).toBe('SELECT 1 FROM dual');
    expect(pasteFromCode('let q = r#"SELECT "a""#;')).toBe('SELECT "a"');
    expect(pasteFromCode('var q = @"SELECT ""a""";')).toBe('SELECT "a"');
    expect(pasteFromCode("sql = '''SELECT 1'''")).toBe('SELECT 1');
    expect(pasteFromCode('"\\u00e9\\u{1F600}\\x41\\0"')).toBe('é😀A\0');
    expect(pasteFromCode('SELECT 1')).toBe('SELECT 1');
  });

  it('types the values typed for parameters, and says what it cannot write', () => {
    expect([codeValue(''), codeValue('NULL'), codeValue(undefined)]).toEqual([null, null, null]);
    expect([codeValue('True'), codeValue('false')]).toEqual([true, false]);
    expect([codeValue('-12'), codeValue('1.5'), codeValue('007')]).toEqual([-12, 1.5, '007']);
    expect(codeValue('12345678901234567890')).toBe('12345678901234567890');
    expect(valueLiteral('java', 3_000_000_000)).toBe('3000000000L');
    expect(valueLiteral('python', null)).toBe('None');
    expect(valueLiteral('python', true)).toBe('True');
    expect(valueLiteral('csharp', null)).toBe('DBNull.Value');
    expect(() => generateSqlCode('node', { engine: 'mongodb', sql: 'x' })).toThrow(SqlCodegenError);
    try {
      generateSqlCode('php', { engine: 'files', sql: 'x' });
    } catch (error) {
      expect(error).toMatchObject({
        key: 'db.code.noLibrary',
        params: { v0: 'PHP', v1: 'DuckDB' },
      });
    }
    for (const engine of ['mysql', 'mariadb', 'sqlite', 'sqlserver', 'duckdb', 'postgresql'])
      expect(generateSqlCode('cli', { engine, sql: 'SELECT 1' })).toContain('SELECT 1;');
    const statement = generateSqlCode('cli', {
      engine: 'sqlite',
      sql: 'SELECT :a, :b, :c',
      values: { a: 'x', b: '2' },
    });
    expect(statement).toContain('.parameter set :p3 NULL');
    expect(generateSqlCode('cli', { engine: 'postgres', sql: 'SELECT :a', values: {} })).toContain(
      'SELECT NULL;',
    );
    expect(generateSqlCode('cli', { engine: 'mysql', sql: 'SQL\nSELECT 1' })).toContain(
      "<<'SQL_END'",
    );
  });
});
