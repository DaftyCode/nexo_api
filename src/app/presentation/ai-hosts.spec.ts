import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { newRequest } from '../domain/models/items';
import { testProviders } from '../testing/providers';
import { mongoHost, requestHost, sqlHost } from './ai-hosts';
import type { DbSection } from './db-panel/section';
import type { MongoExplorer } from './mongo-explorer';
import { WorkspaceState } from './workspace-state';

describe('the places of the assistant', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: testProviders() }));

  it('reads the open request and its response, and adds a script to its tests', () => {
    const state = TestBed.inject(WorkspaceState);
    const host = requestHost(state);
    expect(host.context()).toBeUndefined();
    host.use({ action: 'tests', code: 'x', language: 'js' });
    const id = state.tabsStore.open(
      { ...newRequest('r1'), name: 'Login', tests: 'pm.test("a");' },
      'c1',
    );
    state.tabsStore.setResponse(id, {
      status: 500,
      statusText: 'Error',
      body: '',
      headers: [],
      time: 1,
      size: 0,
      assertions: [],
      logs: [],
      error: 'timeout',
    });
    expect(host.context()).toMatchObject({
      place: 'request',
      request: { name: 'Login' },
      response: { status: 500 },
      collectionId: 'c1',
      error: 'timeout',
    });
    host.use({ action: 'tests', code: 'pm.test("b");', language: 'js' });
    expect(state.active()!.request.tests).toBe('pm.test("a");\n\npm.test("b");\n');
    expect(state.active()!.dirty).toBe(true);
    expect(state.toast()).toMatchObject({ title: 'Added to the tests' });
    state.tabsStore.open(newRequest('r2'));
    host.use({ action: 'tests', code: 'pm.test("c");', language: 'js' });
    expect(state.active()!.request.tests).toBe('pm.test("c");\n');
  });

  it('reads the SQL script with its last error, and opens a query in a new tab', () => {
    const opened: unknown[] = [];
    const open: { tab?: { id: string; kind: string; connection: string } } = {};
    const section = {
      tabs: {
        active: () => open.tab,
        draft: () => ({ text: 'SELEC 1', cursor: 0, database: 'shop' }),
      },
      runner: () => ({
        server: () => ({ database: 'lpc-db' }),
        results: {
          messages: () => [
            { kind: 'error', text: 'db.failure.message', params: { v0: 'syntax' } },
            { kind: 'info', text: 'Done' },
          ],
        },
      }),
      connection: () => ({ id: 'k1', name: 'Prod' }),
      driverOf: () => 'postgres',
      newScript: (connection: string, options: unknown) => opened.push([connection, options]),
    } as unknown as DbSection;
    const host = sqlHost(section, (key, params) => `${key}:${params?.['v0']}`);
    expect(host.context()).toBeUndefined();
    host.use({ action: 'run', code: 'SELECT 1', language: 'sql' });
    expect(opened).toEqual([]);
    open.tab = { id: 't1', kind: 'sql', connection: 'k1' };
    // The connection it works with, by its id, and the database the session is in.
    expect(host.context()).toEqual({
      place: 'sql',
      connection: 'Prod',
      connectionId: 'k1',
      engine: 'postgres',
      database: 'lpc-db',
      script: 'SELEC 1',
      error: 'db.failure.message:syntax',
    });
    host.use({ action: 'run', code: 'SELECT 1', language: 'sql' });
    host.use({ action: 'open', code: 'SELECT 2', language: 'sql' });
    expect(opened).toEqual([
      ['k1', { text: 'SELECT 1', run: true, database: 'shop' }],
      ['k1', { text: 'SELECT 2', run: false, database: 'shop' }],
    ]);
  });

  it('reads the MongoDB query or pipeline, and uses a block as the one or the other', () => {
    const calls: string[] = [];
    const explorer = {
      target: signal({ database: 'shop', collection: 'orders', kind: 'collection' }),
      model: signal({ filter: '{ a: 1 }', projection: '', sort: '{ b: -1 }' }),
      tab: signal('documents'),
      error: signal('bad filter'),
      connection: () => ({ id: 'm1', name: 'Mongo' }),
      pager: { find: async () => void calls.push('find') },
      aggregations: {
        model: signal({ stages: [{ operator: '$match', body: '{}', enabled: true }], text: '' }),
        applyText: () => calls.push('apply'),
        runner: { run: async () => void calls.push('aggregate') },
      },
    };
    const host = mongoHost(explorer as unknown as MongoExplorer);
    expect(host.context()).toEqual({
      place: 'mongo',
      connection: 'Mongo',
      connectionId: 'm1',
      database: 'shop',
      collection: 'orders',
      query: 'filter: { a: 1 }\nsort: { b: -1 }',
      error: 'bad filter',
    });
    explorer.tab.set('aggregations');
    explorer.error.set('');
    explorer.target.set(undefined as never);
    expect(host.context()).toEqual({
      place: 'mongo',
      connection: 'Mongo',
      connectionId: 'm1',
      query: expect.stringContaining('$match'),
    });
    host.use({ action: 'run', code: 'db.orders.find({ c: 2 })', language: 'js' });
    expect(explorer.tab()).toBe('documents');
    expect(explorer.model().filter).toBe('{ c: 2 }');
    host.use({ action: 'use', code: '[{ "$count": "n" }]', language: 'json' });
    expect(explorer.tab()).toBe('aggregations');
    expect(explorer.aggregations.model().text).toBe('[{ "$count": "n" }]');
    host.use({ action: 'run', code: '[{ "$limit": 1 }]', language: 'json' });
    expect(calls).toEqual(['find', 'apply', 'apply', 'aggregate']);
  });
});
