import { describe, expect, it } from 'vitest';
import type { TransferSource } from './ports';
import { defaultExportOptions } from '../domain/db/transfer/export';
import {
  databaseCases as fixture,
  never,
  targetFile as target,
  write,
  written,
} from '../testing/database-cases';

describe('the structure use cases', () => {
  it('reads a table or only the types, and plans with what it is given', async () => {
    const { cases, named } = fixture({
      'db.ddl.model': { table: { name: 't' } },
      'db.ddl.plan': {},
    });
    expect(await cases.structure.model('w', 's')).toEqual({
      table: { name: 't', columns: [], uniques: [], checks: [], foreignKeys: [], indexes: [] },
      types: [],
    });
    await cases.structure.model('w', 's', ['tables', 't']);
    expect(named('db.ddl.model')).toEqual([
      { workspace: 'w', session: 's' },
      { workspace: 'w', session: 's', path: ['tables', 't'] },
    ]);
    const table = (await cases.structure.model('w', 's')).table;
    await cases.structure.plan('w', 's', undefined, undefined);
    await cases.structure.plan('w', 's', table, table, true);
    expect(named('db.ddl.plan')).toEqual([
      { workspace: 'w', session: 's' },
      { workspace: 'w', session: 's', original: table, target: table, cascade: true },
    ]);
  });

  it('runs the statements in a transaction, rolled back on a failure', async () => {
    let failing = false;
    const { cases, named } = fixture({
      'db.execute': () => {
        if (failing) throw new Error('no');
        return {};
      },
    });
    await cases.structure.run('w', 's', ['A', 'B'], { transactional: true, confirmName: 't' });
    expect(named('db.transaction').map((payload) => payload['action'])).toEqual([
      'begin',
      'commit',
    ]);
    expect(named('db.execute')[0]).toMatchObject({ sql: 'A', confirm: true, confirmName: 't' });
    failing = true;
    await expect(cases.structure.run('w', 's', ['C'], { transactional: true })).rejects.toThrow(
      'no',
    );
    expect(named('db.transaction').map((payload) => payload['action'])).toEqual([
      'begin',
      'commit',
      'begin',
      'rollback',
    ]);
    await expect(cases.structure.run('w', 's', ['D'], { transactional: false })).rejects.toThrow();
    expect(named('db.transaction')).toHaveLength(4);
  });
});

describe('the transfer use cases', () => {
  it('converts columns, naming the schema and both drivers only when given', async () => {
    const { cases, named } = fixture({ 'db.convert': { sql: '', columns: [] } });
    await cases.transfer.convert('w', 's', 't', []);
    await cases.transfer.convert('w', 's', 't', [], {
      schema: 'shop',
      sourceDriver: 'mysql',
      targetDriver: 'postgres',
    });
    expect(named('db.convert')).toEqual([
      { workspace: 'w', session: 's', table: 't', columns: [] },
      {
        workspace: 'w',
        session: 's',
        table: 't',
        columns: [],
        schema: 'shop',
        sourceDriver: 'mysql',
        targetDriver: 'postgres',
      },
    ]);
  });

  const job = (sql = 'SELECT 1') => ({
    workspace: 'w',
    session: 's',
    sql,
    format: 'csv' as const,
    options: { ...defaultExportOptions(), header: false },
    shape: { table: 't', style: { name: 'postgresql', quoteOpen: '"', quoteClose: '"' } },
  });
  const columns = [{ name: 'n', typeName: 'int', kind: 'integer' }];

  it('exports every page of a cursor, and closes nothing when the cursor ended', async () => {
    const { cases, named } = fixture({
      'db.execute': { columns, rows: [[1]], cursor: 'c1' },
      'db.fetch': (payload: Record<string, unknown>) =>
        payload['cursor'] === 'c1' ? { rows: [[2]], cursor: 'c2' } : { rows: [[3]], cursor: null },
    });
    const file = target();
    const seen: number[] = [];
    const done = await cases.transfer.exportRows(job(), file, (rows) => seen.push(rows), never);
    expect(done).toEqual({ rows: 3, cancelled: false });
    expect(file.text).toBe('1\n2\n3\n');
    expect(file.closed).toBe(true);
    expect(seen).toEqual([1, 2, 3]);
    expect(named('db.close')).toEqual([]);
  });

  it('drops the file of a cancelled export and closes its cursor', async () => {
    const { cases, named } = fixture({ 'db.execute': { columns, rows: [[1]], cursor: 'c1' } });
    const controller = new AbortController();
    controller.abort();
    const file = target();
    expect(
      await cases.transfer.exportRows(job(), file, () => undefined, controller.signal),
    ).toEqual({ rows: 1, cancelled: true });
    expect(file.discarded).toBe(true);
    expect(named('db.close')).toEqual([{ workspace: 'w', session: 's', cursor: 'c1' }]);
  });

  it('refuses to export what reads no rows, leaving no file', async () => {
    const { cases } = fixture({ 'db.execute': { columns: [], rows: [] } });
    const file = target();
    await expect(
      cases.transfer.exportRows(job('UPDATE t SET a = 1'), file, () => undefined, never),
    ).rejects.toThrow('Only what a query reads can be exported');
    expect(file.discarded).toBe(true);
  });

  it('writes the CREATE TABLE first when the job asks for one', async () => {
    const { cases } = fixture({ 'db.execute': { columns, rows: [] } });
    const file = target();
    await cases.transfer.exportRows(
      { ...job(), format: 'sql', ddlFor: async () => 'CREATE TABLE t (n int)' },
      file,
      () => undefined,
      never,
    );
    expect(file.text).toBe('CREATE TABLE t (n int);\n\n');
  });

  it('copies page by page into a new, emptied table, in one transaction', async () => {
    const { cases, named } = fixture({
      'db.execute': {},
      'db.transaction': {},
      'db.copy': (payload: Record<string, unknown>) =>
        payload['cursor']
          ? { ...written, read: 1, cursor: null }
          : { ...written, read: 1, cursor: 'k', columns: [{ name: 'n' }] },
    });
    const outcome = await cases.transfer.copy(
      {
        ...write,
        schema: 'shop',
        key: ['n'],
        mode: 'upsert',
        source: 'src',
        sql: 'SELECT n',
        stopOnError: true,
        clear: true,
        create: 'CREATE TABLE t (n int)',
        confirm: true,
      },
      'DELETE FROM t',
      () => undefined,
      never,
    );
    expect(outcome).toMatchObject({ read: 2, inserted: 2, cancelled: false });
    expect(named('db.execute').map((payload) => payload['sql'])).toEqual([
      'CREATE TABLE t (n int)',
      'DELETE FROM t',
    ]);
    expect(named('db.transaction').map((payload) => payload['action'])).toEqual([
      'begin',
      'commit',
    ]);
    const [first, second] = named('db.copy');
    expect(first).toMatchObject({ sql: 'SELECT n', schema: 'shop', key: ['n'], confirm: true });
    expect(second).toMatchObject({ cursor: 'k', columns: ['n'], first: 2 });
  });

  it('closes the source cursor of a cancelled copy, and rolls back a failed one', async () => {
    const controller = new AbortController();
    const { cases, named } = fixture({
      'db.transaction': {},
      'db.copy': () => {
        controller.abort();
        return { ...written, read: 1, cursor: 'k' };
      },
    });
    const outcome = await cases.transfer.copy(
      { ...write, source: 'src', sql: 'SELECT 1', stopOnError: true, clear: false },
      '',
      () => undefined,
      controller.signal,
    );
    expect(outcome.cancelled).toBe(true);
    expect(named('db.close')).toEqual([{ workspace: 'w', session: 'src', cursor: 'k' }]);
    expect(named('db.transaction').map((payload) => payload['action'])).toEqual([
      'begin',
      'rollback',
    ]);

    const failing = fixture({
      'db.transaction': {},
      'db.copy': () => {
        throw new Error('lost');
      },
    });
    await expect(
      failing.cases.transfer.copy(
        { ...write, source: 'src', sql: 'SELECT 1', stopOnError: true, clear: false },
        '',
        () => undefined,
        never,
      ),
    ).rejects.toThrow('lost');
    expect(failing.named('db.transaction').map((payload) => payload['action'])).toEqual([
      'begin',
      'rollback',
    ]);
  });

  it('imports a file in batches, with the columns that go somewhere', async () => {
    const { cases, named } = fixture({ 'db.import': written });
    const bytes = new TextEncoder().encode('a,b\n1,x\n');
    const source: TransferSource = {
      name: 'in.csv',
      size: bytes.length,
      read: async (offset, length) => bytes.slice(offset, offset + length),
      close: async () => undefined,
    };
    const outcome = await cases.transfer.importFile(
      {
        ...write,
        stopOnError: false,
        clear: false,
        format: 'csv',
        separator: ',',
        header: true,
        columns: [
          { name: 'a', target: 'a', kind: 'integer' },
          { name: 'b', target: '', kind: 'text' },
        ],
        transform: { trim: true, emptyAsNull: true },
      },
      '',
      source,
      () => undefined,
      never,
    );
    expect(outcome).toMatchObject({ read: 1, inserted: 1 });
    expect(named('db.import')[0]).toMatchObject({ columns: ['a'], rows: [[1]], first: 1 });
  });
});
