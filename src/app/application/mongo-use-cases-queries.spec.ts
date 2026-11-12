import { MongoUseCases } from './mongo-use-cases';
import { WorkspaceDocument } from '../domain/models';
import { VariableScopes } from '../domain/variables';

function fakeApi() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, answer?: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answer?.(...args);
    };
  const api = {
    execute: record('execute', () => ({ serverVersion: '8.0.4' })),
    save: record('save', (document) => ({
      ...(document as WorkspaceDocument),
      revision: (document as WorkspaceDocument).revision + 1,
    })),
    remove: record('remove'),
    document: record('document', (id) => ({
      id,
      kind: 'query-history',
      value: { database: 'shop', collection: 'orders', filter: '{a: 1}' },
    })),
    putSecret: record('putSecret'),
    removeSecret: record('removeSecret'),
  };
  return { api: api as never, calls };
}

const scopes = (environment: Record<string, string>): VariableScopes => ({
  environment: Object.entries(environment).map(([key, value]) => ({
    key,
    value,
    enabled: true,
    secret: false,
  })),
  collection: [],
  globals: [],
});

describe('MongoUseCases', () => {
  it('queries a saved connection with its variables replaced and its vault references kept', async () => {
    const { api, calls } = fakeApi();
    const mongo = new MongoUseCases(api, () => 'q1');
    const connection = {
      id: 'c1',
      workspace_id: 'local',
      kind: 'connection',
      name: 'Local',
      revision: 1,
      updated_at: 0,
      value: { uri: 'mongodb://{{host}}', password: '{{vault:mongo-password:c1}}' },
    } as WorkspaceDocument;
    const target = { database: 'shop', collection: 'orders' };
    await mongo.queries.find(
      'local',
      connection,
      scopes({ host: 'db.test' }),
      target,
      { filter: { a: 1 } },
      'r1',
      50,
    );
    await mongo.queries.count(
      'local',
      connection,
      scopes({ host: 'db.test' }),
      target,
      { filter: { a: 1 }, projection: { a: 1 }, sort: { a: 1 }, limit: 5 },
      'r2',
    );
    const executed = calls.filter((c) => c.method === 'execute').map((c) => c.args);
    const sent = { uri: 'mongodb://db.test', password: '{{vault:mongo-password:c1}}' };
    expect(executed).toEqual([
      [
        'mongo.find',
        {
          workspace: 'local',
          connection: sent,
          ...target,
          filter: { a: 1 },
          id: 'r1',
          pageSize: 50,
        },
      ],
      // A count takes no projection nor sort.
      [
        'mongo.count',
        { workspace: 'local', connection: sent, ...target, filter: { a: 1 }, limit: 5, id: 'r2' },
      ],
    ]);
    const failing = {
      execute: async () => {
        throw new Error('gone');
      },
    };
    await expect(
      new MongoUseCases(failing as never, () => 'x').queries.close('local', 'c'),
    ).resolves.toBeUndefined();
  });

  it('saves queries without empty fields and keeps the history without results', async () => {
    const { api } = fakeApi();
    let id = 0;
    const mongo = new MongoUseCases(api, () => `q${++id}`);
    const value = {
      connection: 'c1',
      database: 'shop',
      collection: 'orders',
      filter: "{status: 'A'}",
      projection: '',
      sort: ' ',
      collation: '',
      hint: '',
      skip: '',
      limit: '10',
    };
    const saved = await mongo.queries.saveQuery('local', ' ', value);
    expect(saved).toMatchObject({
      id: 'q1',
      kind: 'query',
      name: "shop.orders {status: 'A'}",
      value: {
        connection: 'c1',
        database: 'shop',
        collection: 'orders',
        filter: "{status: 'A'}",
        limit: '10',
      },
    });
    expect(Object.keys(saved.value as object)).not.toContain('sort');
    const history = await mongo.queries.recordHistory('local', value);
    expect(history).toMatchObject({
      id: 'q2',
      kind: 'query-history',
      name: "shop.orders {status: 'A'}",
    });
    expect(await mongo.queries.historyQuery(history)).toMatchObject({
      filter: "{status: 'A'}",
      limit: '10',
    });
    // Listed without a value, it is read from the workspace.
    expect(await mongo.queries.historyQuery({ ...history, value: null })).toMatchObject({
      filter: '{a: 1}',
    });
  });

  it('manages indexes and the profiler through the saved connection, and explains queries', async () => {
    const { api, calls } = fakeApi();
    const mongo = new MongoUseCases(api, () => 'x');
    const connection = {
      id: 'c1',
      workspace_id: 'local',
      kind: 'connection',
      name: 'Local',
      revision: 1,
      updated_at: 0,
      value: { uri: 'mongodb://{{host}}/' },
    } as WorkspaceDocument;
    const env = scopes({ host: 'db.test' });
    const target = { database: 'shop', collection: 'orders' };
    const sent = () => calls.at(-1)?.args;
    await mongo.tuning.createIndex('local', connection, env, target, { at: -1 }, {});
    expect(sent()).toEqual([
      'mongo.index.create',
      {
        workspace: 'local',
        connection: { uri: 'mongodb://db.test/' },
        connectionId: 'c1',
        database: 'shop',
        collection: 'orders',
        keys: { at: -1 },
      },
    ]);
    await mongo.tuning.hideIndex('local', connection, env, target, 'at_-1', true);
    expect(sent()?.[1]).toMatchObject({ name: 'at_-1', hidden: true, connectionId: 'c1' });
    await mongo.tuning.dropIndex('local', connection, env, target, 'at_-1', 'at_-1');
    expect(sent()?.[1]).toMatchObject({ name: 'at_-1', confirm: 'at_-1' });
    await mongo.tuning.setProfile('local', connection, env, 'shop', 1, 50);
    expect(sent()).toEqual([
      'mongo.profile.set',
      expect.objectContaining({ connectionId: 'c1', database: 'shop', level: 1, slowms: 50 }),
    ]);
    await mongo.tuning.explain(
      'local',
      connection,
      env,
      target,
      { query: { filter: { a: 1 }, limit: 5 } },
      true,
      'e1',
    );
    expect(sent()).toEqual([
      'mongo.explain',
      {
        workspace: 'local',
        connection: { uri: 'mongodb://db.test/' },
        database: 'shop',
        collection: 'orders',
        filter: { a: 1 },
        limit: 5,
        verbosity: 'executionStats',
        id: 'e1',
      },
    ]);
    await mongo.tuning.explain(
      'local',
      connection,
      env,
      target,
      { pipeline: [{ $match: {} }] },
      false,
      'e2',
    );
    expect(sent()?.[1]).toMatchObject({ pipeline: [{ $match: {} }], verbosity: 'queryPlanner' });
    await mongo.tuning.profileEntries('local', connection, env, 'shop');
    expect(sent()?.[1]).not.toHaveProperty('collection');
    expect(sent()?.[1]).not.toHaveProperty('connectionId');
  });
});
