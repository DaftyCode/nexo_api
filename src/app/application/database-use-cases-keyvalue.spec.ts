import { describe, expect, it } from 'vitest';
import { databaseCases } from '../testing/database-cases';

describe('the key-value use cases', () => {
  it('scan, read, change and command on the session of a key tab', async () => {
    const { cases, named } = databaseCases({
      'db.kv.scan': { keys: [{ key: 'a', type: 'string' }], cursor: '12' },
      'db.kv.get': { key: 'a', type: 'string', value: 'v', elements: [] },
      'db.kv.write': { key: 'a', done: true },
      'db.kv.command': { reply: 'OK', elapsedMs: 1 },
    });
    const kv = cases.keyValue;
    expect((await kv.scan('w', 'keys:t1', { pattern: 'a*', type: '', count: 100 })).cursor).toBe(
      '12',
    );
    expect(named('db.kv.scan')[0]).toEqual({
      workspace: 'w',
      session: 'keys:t1',
      pattern: 'a*',
      count: 100,
    });
    await kv.get('w', 'keys:t1', 'a');
    await kv.get('w', 'keys:t1', 'list', '100');
    expect(named('db.kv.get')).toEqual([
      { workspace: 'w', session: 'keys:t1', key: 'a' },
      { workspace: 'w', session: 'keys:t1', key: 'list', cursor: '100' },
    ]);
    await kv.write('w', 'keys:t1', { key: 'a', action: 'expire', ttlMs: 1000 });
    expect(named('db.kv.write')[0]).toMatchObject({ action: 'expire', ttlMs: 1000 });
    await kv.command('w', 'keys:t1', 'GET a');
    await kv.command('w', 'keys:t1', 'FLUSHDB', { confirmName: 'FLUSHDB' });
    await kv.command('w', 'keys:t1', 'SET a b', { confirm: true });
    expect(named('db.kv.command')).toEqual([
      { workspace: 'w', session: 'keys:t1', line: 'GET a' },
      { workspace: 'w', session: 'keys:t1', line: 'FLUSHDB', confirmName: 'FLUSHDB' },
      { workspace: 'w', session: 'keys:t1', line: 'SET a b', confirm: true },
    ]);
  });

  it('sends a request of the API on the session of a console', async () => {
    const { cases, named } = databaseCases({
      'db.rest.request': { status: 200, body: { hits: {} }, elapsedMs: 2 },
    });
    await cases.rest.request('w', 'rest:t1', { method: 'GET', path: '_cat/indices' });
    await cases.rest.request(
      'w',
      'rest:t1',
      { method: 'DELETE', path: 'shop', body: null },
      { confirmName: 'shop' },
    );
    await cases.rest.request('w', 'rest:t1', { method: 'PUT', path: 'x' }, { confirm: true });
    expect(named('db.rest.request')).toEqual([
      { workspace: 'w', session: 'rest:t1', method: 'GET', path: '_cat/indices' },
      {
        workspace: 'w',
        session: 'rest:t1',
        method: 'DELETE',
        path: 'shop',
        body: null,
        confirmName: 'shop',
      },
      { workspace: 'w', session: 'rest:t1', method: 'PUT', path: 'x', confirm: true },
    ]);
  });
});
