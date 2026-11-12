import { keySecret, MongoUseCases, passwordSecret, resolveVariables } from './mongo-use-cases';
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
  it('saves the password and the key in the vault and only their references', async () => {
    const { api, calls } = fakeApi();
    const mongo = new MongoUseCases(api, () => 'c1');
    const saved = await mongo.connections.save(
      'local',
      ' Production ',
      { uri: 'mongodb://ana@db.test/', folder: ' ', color: '#57ab5a', readOnly: true },
      { password: 's3cret', keyPem: '-----BEGIN PRIVATE KEY-----' },
    );
    expect(calls.filter((c) => c.method === 'putSecret').map((c) => c.args)).toEqual([
      [passwordSecret('c1'), 's3cret'],
      [keySecret('c1'), '-----BEGIN PRIVATE KEY-----'],
    ]);
    expect(saved).toMatchObject({
      id: 'c1',
      kind: 'connection',
      name: 'Production',
      revision: 1,
      value: {
        uri: 'mongodb://ana@db.test/',
        password: '{{vault:mongo-password:c1}}',
        keyPem: '{{vault:mongo-key:c1}}',
        color: '#57ab5a',
        readOnly: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain('s3cret');
    expect((saved.value as object as Record<string, unknown>)['folder']).toBeUndefined();

    // Saved again with nothing typed, the stored references stay; a reference typed is kept.
    const again = await mongo.connections.save(
      'local',
      'Production',
      saved.value as never,
      { password: '{{vault:shared}}' },
      saved,
    );
    expect(again.revision).toBe(2);
    expect(again.value).toMatchObject({ password: '{{vault:shared}}' });
    expect(calls.filter((c) => c.method === 'putSecret')).toHaveLength(2);
  });

  it('deletes the secrets it created with the connection', async () => {
    const { api, calls } = fakeApi();
    const mongo = new MongoUseCases(api, () => 'c1');
    await mongo.connections.remove({
      id: 'c1',
      workspace_id: 'local',
      kind: 'connection',
      name: 'x',
      revision: 1,
      updated_at: 0,
      value: { uri: 'mongodb://h', password: '{{vault:mongo-password:c1}}', keyPem: '{{vault:k}}' },
    });
    expect(calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['remove', expect.objectContaining({ id: 'c1' })],
      ['removeSecret', 'mongo-password:c1'],
    ]);
  });

  it('tests with environment variables replaced and typed secrets as they are', async () => {
    const { api, calls } = fakeApi();
    const mongo = new MongoUseCases(api, () => 'c1');
    await mongo.connections.test(
      'local',
      {
        uri: 'mongodb://{{user}}@{{host}}/?authSource={{vault:db}}&x={{missing}}',
        password: '{{vault:mongo-password:c1}}',
        caPem: ' ',
        keyPem: '{{vault:mongo-key:c1}}',
      },
      { password: 'typed' },
      scopes({ user: 'ana', host: '{{name}}.test:27017', name: 'db' }),
    );
    expect(calls[0]).toEqual({
      method: 'execute',
      args: [
        'mongo.test',
        {
          workspace: 'local',
          connection: {
            uri: 'mongodb://ana@db.test:27017/?authSource={{vault:db}}&x={{missing}}',
            password: 'typed',
            keyPem: '{{vault:mongo-key:c1}}',
          },
        },
      ],
    });
    expect(resolveVariables('{{$guid}}', scopes({}))).toBe('{{$guid}}');
  });

  it('imports Compass connections with their passwords in the vault', async () => {
    const { api, calls } = fakeApi();
    let id = 0;
    const mongo = new MongoUseCases(api, () => `c${++id}`);
    const saved = await mongo.connections.importCompass(
      'local',
      JSON.stringify({
        type: 'Compass Connections',
        connections: [
          {
            connectionOptions: { connectionString: 'mongodb://ana:pw@h1/' },
            favorite: { name: 'A' },
          },
          { connectionOptions: { connectionString: 'mongodb://h2/' } },
        ],
      }),
    );
    expect(saved.map((d) => [d.id, d.name, d.value])).toEqual([
      ['c1', 'A', { uri: 'mongodb://ana@h1/', password: '{{vault:mongo-password:c1}}' }],
      ['c2', 'Connection 2', { uri: 'mongodb://h2/' }],
    ]);
    expect(calls.filter((c) => c.method === 'putSecret').map((c) => c.args)).toEqual([
      ['mongo-password:c1', 'pw'],
    ]);
    await expect(
      mongo.connections.importCompass('local', '{"type":"Compass Connections","connections":[]}'),
    ).rejects.toThrow('The file has no connections');
  });
});
