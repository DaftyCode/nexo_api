import { DatabaseUseCases, DatabasePorts, connectionVariables } from './database-use-cases';
import { WorkspaceDocument } from '../domain/models';
import { VariableScopes } from '../domain/variables';

function fixture(answers: Record<string, unknown> = {}) {
  const calls: [string, unknown][] = [];
  const secrets = new Map<string, string>();
  const saved: WorkspaceDocument[] = [];
  const removed: string[] = [];
  const api = {
    execute: async (operation: string, payload: unknown) => {
      calls.push([operation, payload]);
      return answers[operation];
    },
    save: async (document: WorkspaceDocument) => {
      saved.push(document);
      return { ...document, revision: document.revision + 1 };
    },
    remove: async (document: WorkspaceDocument) => void removed.push(document.id),
    putSecret: async (name: string, value?: string) => void secrets.set(name, value ?? ''),
    removeSecret: async (name: string) => void secrets.delete(name),
  } as unknown as DatabasePorts;
  return { cases: new DatabaseUseCases(api), calls, secrets, saved, removed };
}

const scopes: VariableScopes = {
  environment: [{ key: 'host', value: 'db.test', enabled: true, secret: false }],
  collection: [],
  globals: [],
};
const document = (id: string, value: unknown): WorkspaceDocument => ({
  id,
  workspace_id: 'w',
  kind: 'connection',
  name: id,
  revision: 3,
  updated_at: 0,
  value,
});

describe('database use cases', () => {
  it('sends only the variables a connection names, and never vault references', () => {
    expect(
      connectionVariables(
        { host: '{{host}}', user: '{{missing}}', password: '{{vault:x}}' },
        scopes,
      ),
    ).toEqual({ host: 'db.test' });
  });

  it('tests a connection being written with its typed secrets in the vault', async () => {
    const { cases, calls, secrets } = fixture({ 'db.test': { pingMs: 3 } });
    const value = {
      driver: 'postgres',
      host: '{{host}}',
      tls: { mode: 'verify' as const, certPem: 'CERT' },
    };
    await cases.connections.test('w', 'c1', value, { password: 'p', keyPem: 'K' }, scopes);
    expect(secrets.get('db-password:c1')).toBe('p');
    expect(secrets.get('db-key:c1')).toBe('K');
    expect(calls[0]).toEqual([
      'db.test',
      {
        workspace: 'w',
        connection: {
          driver: 'postgres',
          host: '{{host}}',
          password: '{{vault:db-password:c1}}',
          tls: { mode: 'verify', certPem: 'CERT', keyPem: '{{vault:db-key:c1}}' },
        },
        variables: { host: 'db.test' },
      },
    ]);
    // The form's value is not changed.
    expect(value.tls).toEqual({ mode: 'verify', certPem: 'CERT' });
  });

  it('saves with the revision it was loaded from, and keeps vault references typed as such', async () => {
    const { cases, saved, secrets } = fixture();
    const existing = document('c1', {});
    await cases.connections.save(
      'w',
      'c1',
      ' Shop ',
      { driver: 'postgres', host: 'h' },
      { password: '{{vault:shared}}' },
      existing,
    );
    expect(saved[0]).toEqual(
      expect.objectContaining({
        name: 'Shop',
        revision: 3,
        kind: 'connection',
        value: { driver: 'postgres', host: 'h', password: '{{vault:shared}}' },
      }),
    );
    expect(secrets.size).toBe(0);
  });

  it('keeps the secrets a duplicate still reads when the original is deleted', async () => {
    const { cases, secrets, removed } = fixture();
    secrets.set('db-password:a', 'p');
    const original = document('a', { driver: 'postgres', password: '{{vault:db-password:a}}' });
    const copy = document('b', { driver: 'postgres', password: '{{vault:db-password:a}}' });
    await cases.connections.remove(original, [original, copy]);
    expect(removed).toEqual(['a']);
    expect(secrets.has('db-password:a')).toBe(true);
    await cases.connections.remove(copy, [copy]);
    await cases.connections.remove(original, []);
    expect(secrets.has('db-password:a')).toBe(false);
  });

  it('moves a connection to a folder and out of it, and keeps filters', async () => {
    const { cases, saved } = fixture();
    const connection = document('a', { driver: 'postgres', folder: 'Old' });
    await cases.connections.moveTo(connection, ' New ');
    expect(saved[0].value).toEqual({ driver: 'postgres', folder: 'New' });
    await cases.connections.moveTo(connection, '');
    expect(saved[1].value).toEqual({ driver: 'postgres' });
    await cases.connections.setFilters(connection, [{ path: ['db'], exclude: 'tmp_*' }]);
    expect(saved[2].value).toEqual(
      expect.objectContaining({ filters: [{ path: ['db'], exclude: 'tmp_*' }] }),
    );
  });

  it('opens the navigator session with the variables, and asks each driver once', async () => {
    const { cases, calls } = fixture({
      'db.connect': { serverVersion: '18' },
      'db.tree': { nodes: [{ name: 'shop' }] },
      'db.dialect': { dialect: { quoteOpen: '"' } },
    });
    const connection = document('a', { driver: 'postgres', host: '{{host}}' });
    await cases.navigator.connect('w', connection, 'tree:a', scopes);
    expect(calls[0]).toEqual([
      'db.connect',
      { workspace: 'w', connectionId: 'a', session: 'tree:a', variables: { host: 'db.test' } },
    ]);
    expect(await cases.navigator.tree('w', 'tree:a', ['shop'])).toEqual([
      expect.objectContaining({ name: 'shop' }),
    ]);
    await cases.navigator.hello('w', 'postgres');
    await cases.navigator.hello('w', 'postgres');
    expect(calls.filter(([operation]) => operation === 'db.dialect').length).toBe(1);
  });
});
