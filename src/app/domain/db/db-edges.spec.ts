import { describe, expect, it } from 'vitest';
import { readCommand, scriptParts } from './client-commands';
import { engineOfScheme, engineProfile, tlsModeOf } from './engines';
import type { ResultColumn } from './results';
import { generateFor, generateRows } from './sql-generate';
import { groupQuery, qualifiedName, readHistory, readScript } from './sql';
import { emptyTableQuery, foreignKeys, tableSelect } from './table-query';
import { formatDbUrl, parseDbUrl } from './url';
import { formatSqliteUrl, parseSqliteUrl } from './url/sqlite';

const postgres = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
const sqlite = { name: 'sqlite', quoteOpen: '"', quoteClose: '"' };
const mysql = { name: 'mysql', quoteOpen: '`', quoteClose: '`', parameters: 'question' };
const parts = {
  driver: 'postgres',
  host: 'db',
  port: '',
  database: '',
  user: '',
  tlsMode: 'disable' as const,
  params: [],
};

describe('database URLs, at their edges', () => {
  it('reads a URL without a database, with a hash, a bare parameter and its password', () => {
    const parsed = parseDbUrl('postgresql://db#frag');
    expect(parsed).toMatchObject({ host: 'db', database: '', user: '' });
    const full = parseDbUrl(
      'postgres://a@db/shop?password=p&sslmode=nonsense&application_name=x+y&flag',
    );
    expect(full.password).toBe('p');
    expect(full.params).toEqual({ application_name: 'x y' });
    expect(full.ignored).toEqual(['sslmode', 'flag']);
    expect(() => parseDbUrl('nothing')).toThrow();
    expect(() => parseDbUrl('oracle://db')).toThrow();
  });

  it('writes a URL with only a host', () => {
    expect(formatDbUrl(parts)).toBe('postgresql://db');
  });

  it('reads and writes SQL Server URLs of every shape', () => {
    const jdbc = parseDbUrl(
      'jdbc:sqlserver://;serverName=db;portNumber=1500;instanceName=SQL;nothing;encrypt=no',
    );
    expect(jdbc).toMatchObject({ host: 'db', port: '1500', tlsMode: 'disable' });
    expect(jdbc.params).toEqual({ instance: 'SQL' });
    const strict = parseDbUrl('sqlserver://db;port=1433;trustServerCertificate=true');
    expect(strict.tlsMode).toBe('require');
    const url = parseDbUrl('sqlserver://db/INST?flag&user=u');
    expect(url).toMatchObject({ host: 'db', user: 'u' });
    expect(url.params).toEqual({ instance: 'INST' });
    expect(url.ignored).toEqual(['flag']);
    expect(parseDbUrl('sqlserver://db?encrypt=true').tlsMode).toBe('verify');
    expect(formatDbUrl({ ...parts, driver: 'mssql' })).toBe('jdbc:sqlserver://db;encrypt=false');
  });

  it('reads and writes SQLite URLs with bare parameters', () => {
    expect(parseSqliteUrl('jdbc:sqlite:/a.db?create&journal_mode=wal').params).toEqual({
      create: '',
      journal_mode: 'wal',
    });
    expect(formatSqliteUrl({ ...parts, driver: 'sqlite', database: 'a.db' })).toBe(
      'jdbc:sqlite:a.db',
    );
  });
});

describe('engines, at their edges', () => {
  it('reads every TLS word, and a scheme of a module', () => {
    expect(['disable', 'disabled', 'allow', 'false'].map(tlsModeOf)).toEqual(
      Array(4).fill('disable'),
    );
    expect(tlsModeOf('prefer')).toBe('prefer');
    expect(tlsModeOf('verify-ca')).toBe('verify');
    expect(tlsModeOf('maybe')).toBeUndefined();
    expect(engineOfScheme('redis', ['redis'])).toBe('redis');
    expect(engineOfScheme('redis')).toBe('');
    expect(engineProfile('postgres').schemaStatement?.('shop')).toBe('SET search_path TO shop');
  });
});

describe('client commands, at their edges', () => {
  it('reads unset and export, and refuses a set without a value', () => {
    expect(readCommand('@unset name')).toEqual({ kind: 'unset', name: 'name' });
    expect(readCommand('@unset 1x')).toEqual({ error: 'db.client.unset' });
    expect(readCommand('@set name')).toEqual({ error: 'db.client.set' });
    expect(readCommand('@export csv')).toEqual({ kind: 'export', options: 'csv' });
  });

  it('cuts a script whose SQL starts after blank lines', () => {
    expect(scriptParts('\nSELECT 1\n@echo hi\n\n')).toEqual([
      { kind: 'sql', text: '\nSELECT 1', offset: 0 },
      { kind: 'command', command: { kind: 'echo', text: 'hi' }, offset: 10, line: 3 },
    ]);
  });
});

describe('SQL generated from a table, at its edges', () => {
  const keyless = { name: 'log', columns: [{ name: 'a' }, { name: 'b' }] };

  it('names every column when the table has no key, and merges in SQLite', () => {
    expect(generateFor(keyless, 'update', postgres)).toBe(
      'UPDATE log\nSET a = :a, b = :b\nWHERE a = :a AND b = :b;',
    );
    expect(
      generateFor(
        { name: 't', columns: [{ name: 'id', key: true }, { name: 'v' }] },
        'merge',
        sqlite,
      ),
    ).toBe(
      'INSERT INTO t (id, v)\nVALUES (:id, :v)\nON CONFLICT (id) DO UPDATE SET v = excluded.v;',
    );
    expect(generateFor(keyless, 'merge', postgres)).toContain('ON t.a = s.a AND t.b = s.b');
  });

  it('writes rows without a key, NULL by IS NULL', () => {
    const columns: ResultColumn[] = [
      { name: 'a', typeName: 'text', kind: 'text' },
      { name: 'b', typeName: 'text', kind: 'text' },
    ];
    expect(generateRows('delete', { name: 'log' }, columns, [['x', null]], postgres)).toBe(
      "DELETE FROM log WHERE a = 'x' AND b IS NULL;",
    );
    expect(generateRows('insert', { name: 'log' }, columns, [['x', null]], postgres)).toBe(
      "INSERT INTO log (a, b) VALUES ('x', NULL);",
    );
  });
});

describe('scripts, history and table queries, at their edges', () => {
  it('reads a saved script and a history entry defensively', () => {
    expect(readScript(null)).toEqual({ connectionId: '', sql: '' });
    expect(readScript({ connectionId: 'c', sql: 's', folder: ' f ', database: ' d ' })).toEqual({
      connectionId: 'c',
      sql: 's',
      folder: 'f',
      database: 'd',
    });
    expect(readHistory('h', null)).toBeUndefined();
    expect(readHistory('h', { sql: 's', connectionId: 'c', affected: 2, error: 'e' })).toEqual({
      id: 'h',
      connectionId: 'c',
      sql: 's',
      startedAt: 0,
      durationMs: 0,
      affected: 2,
      error: 'e',
    });
  });

  it('groups rows by columns, and names nothing for no node', () => {
    expect(groupQuery('t', ['a', 'B'], postgres)).toBe(
      'SELECT a, "B", count(*) AS nexo_count FROM t GROUP BY a, "B" ORDER BY nexo_count DESC',
    );
    expect(qualifiedName([], postgres)).toBe('');
  });

  it('looks for text as each engine casts it, and keeps rows that are not null', () => {
    const query = {
      ...emptyTableQuery(),
      quick: [
        { column: 'a', operator: 'contains' as const, value: { $t: 'integer', v: 5 } },
        { column: 'b', operator: 'notnull' as const },
        { column: 'c', operator: 'contains' as const, value: null },
      ],
    };
    const tsql = { name: 'tsql', quoteOpen: '[', quoteClose: ']', parameters: 'named' };
    expect(tableSelect('t', query, tsql).sql).toContain('CAST(a AS NVARCHAR(MAX)) LIKE @P1');
    expect(tableSelect('t', query, mysql).sql).toContain('CAST(a AS CHAR) LIKE ?');
    expect(tableSelect('t', query, { ...sqlite, parameters: 'question' }).sql).toContain(
      'CAST(a AS TEXT) LIKE ?',
    );
    const other = tableSelect('t', query, { name: 'db2', quoteOpen: '"', quoteClose: '"' });
    expect(other.sql).toContain('CAST(a AS VARCHAR(4000))');
    expect(other.sql).toContain('b IS NOT NULL');
    expect(other.params).toEqual(['%5%', '%%']);
  });

  it('reads foreign keys without a schema column', () => {
    const keys = foreignKeys(
      {
        columns: ['Name', 'Columns', 'Table', 'Referenced columns'],
        rows: [['fk', 'a, b', 't', 'x']],
      },
      { schema: 'Schema', table: 'Table' },
      String,
    );
    expect(keys).toEqual([
      { name: 'fk', columns: ['a', 'b'], schema: '', table: 't', referenced: ['x'] },
    ]);
  });
});
