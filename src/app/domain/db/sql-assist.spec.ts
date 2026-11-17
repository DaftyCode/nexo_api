import { readCommand, scriptParts, withClientVariables } from './client-commands';
import { bindParameters, parametersOf } from './sql-params';
import { generateFor, generateRows } from './sql-generate';
import { SQL_TEMPLATES, readTemplates, snippetText } from './sql-templates';

const postgres = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
const mysql = { name: 'mysql', quoteOpen: '`', quoteClose: '`' };

describe('parameters of a statement', () => {
  it('finds :names and ? outside strings, comments, casts and assignments', () => {
    const sql =
      "SELECT :id, ':no', x::text, a := 1, :id -- :no\nWHERE b = ? /* :no */ AND c = :name";
    expect(parametersOf(sql, true)).toEqual({ names: ['id', 'name'], positional: 1 });
    expect(parametersOf("SELECT data ? 'key' FROM t", false).positional).toBe(0);
  });

  it('binds them as the driver does, a quote in a value breaking nothing', () => {
    const sql = 'SELECT * FROM t WHERE a = :id OR b = :id AND c = :name';
    const values = { id: 7, name: "O'Brien" };
    expect(bindParameters(sql, 'numbered', values)).toEqual({
      sql: 'SELECT * FROM t WHERE a = $1 OR b = $1 AND c = $2',
      params: [7, "O'Brien"],
    });
    expect(bindParameters(sql, 'question', values).params).toEqual([7, 7, "O'Brien"]);
    expect(bindParameters(sql, 'named', values).sql).toBe(
      'SELECT * FROM t WHERE a = @P1 OR b = @P1 AND c = @P2',
    );
    expect(bindParameters('SELECT ?, ?', 'question', {}, [1, 'x'])).toEqual({
      sql: 'SELECT ?, ?',
      params: [1, 'x'],
    });
  });
});

describe('client commands', () => {
  it('cuts a script into SQL and commands, and refuses what it does not know', () => {
    const parts = scriptParts('@set id = 7\nSELECT ${id};\n@echo done\nSELECT 2');
    expect(parts.map((part) => part.kind)).toEqual(['command', 'sql', 'command', 'sql']);
    expect(parts[0]).toEqual(
      expect.objectContaining({ command: { kind: 'set', name: 'id', value: '7' }, line: 1 }),
    );
    expect(parts[1]).toEqual({ kind: 'sql', text: 'SELECT ${id};', offset: 12 });
    expect(readCommand("@set who = 'O''Brien'")).toEqual({
      kind: 'set',
      name: 'who',
      value: "O'Brien",
    });
    expect(readCommand('@include C:/data/evil.sql')).toEqual({ error: 'db.client.include' });
    expect(readCommand('@include ../x')).toEqual({ error: 'db.client.include' });
    expect(readCommand('@include Daily totals')).toEqual({
      kind: 'include',
      script: 'Daily totals',
    });
    expect(readCommand('@shell rm -rf /')).toEqual({
      error: 'db.client.unknown',
      params: { v0: '@shell' },
    });
    expect(() => scriptParts('@nope')).toThrow('db.client.unknown');
  });

  it('replaces ${variables}, naming a missing one', () => {
    const variables = new Map([['id', '7']]);
    expect(withClientVariables('SELECT ${id}', variables)).toBe('SELECT 7');
    expect(() => withClientVariables('SELECT ${other}', variables)).toThrow('db.client.missing');
  });
});

describe('generated SQL', () => {
  const table = {
    schema: 'shop',
    name: 'orders',
    columns: [{ name: 'id', key: true }, { name: 'status' }, { name: 'total' }],
  };
  it('writes each statement of a table with the key in the WHERE', () => {
    expect(generateFor(table, 'select', postgres)).toBe(
      'SELECT id, status, total\nFROM shop.orders;',
    );
    expect(generateFor(table, 'update', postgres)).toBe(
      'UPDATE shop.orders\nSET status = :status, total = :total\nWHERE id = :id;',
    );
    // Names are quoted only when the engine needs it.
    expect(generateFor(table, 'delete', mysql)).toBe(
      'DELETE FROM shop.orders' + String.fromCharCode(10) + 'WHERE id = :id;',
    );
    expect(generateFor(table, 'merge', mysql)).toContain(
      'ON DUPLICATE KEY UPDATE status = VALUES(status)',
    );
    expect(generateFor(table, 'merge', postgres)).toContain('MERGE INTO shop.orders t');
  });

  it('writes the statements of rows with their values', () => {
    const columns = [
      { name: 'id', typeName: 'int', kind: 'integer', key: true },
      { name: 'status', typeName: 'text', kind: 'text' },
    ];
    const rows = [[1, "it's"]];
    expect(generateRows('update', { name: 'orders' }, columns, rows, postgres)).toBe(
      "UPDATE orders SET status = 'it''s' WHERE id = 1;",
    );
    expect(generateRows('delete', { name: 'orders' }, columns, rows, postgres)).toBe(
      'DELETE FROM orders WHERE id = 1;',
    );
  });
});

describe('templates', () => {
  it('end their fields where the cursor goes, and keep only well formed ones', () => {
    expect(snippetText(SQL_TEMPLATES[0])).toBe('SELECT * FROM ${table}${}');
    expect(
      readTemplates('[{"name":"mine","text":"SELECT 1"},{"name":"bad name","text":"x"}]'),
    ).toEqual([{ name: 'mine', description: '', text: 'SELECT 1' }]);
    expect(readTemplates('not json')).toEqual([]);
  });
});
