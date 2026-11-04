import { DataUseCases } from './data-use-cases';
import { IntegrationUseCases } from './integration-use-cases';
import { ProtocolUseCases } from './protocol-use-cases';
import { ApiPort } from './ports';
import { WorkspaceDocument, newRequest } from '../domain/models';

/** Records every port call and answers execute calls from a table. */
function fakeApi(results: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result?: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result?.(...args);
    };
  const api = {
    execute: record('execute', (operation) => results[operation as string] ?? {}),
    git: record('git', () => ({ success: true, stdout: 'ok', stderr: '' })),
    save: record('save', (document) => document),
    remove: record('remove'),
    revisions: record('revisions', () => []),
    putSecret: record('putSecret'),
    removeSecret: record('removeSecret'),
    secretNames: record('secretNames', () => ['token']),
  } as unknown as ApiPort;
  return { api, calls };
}
const dataset = (id: string): WorkspaceDocument => ({
  id,
  workspace_id: 'w1',
  kind: 'dataset',
  name: 'Old',
  revision: 3,
  updated_at: 0,
  value: {},
});

describe('DataUseCases', () => {
  it('imports a dataset and updates its existing document', async () => {
    const { api, calls } = fakeApi({ 'dataset.import': { id: 'd1', rows: 2, columns: ['a'] } });
    const data = new DataUseCases(api, () => 'new-id');
    const result = await data.importDataset(
      'w1',
      { id: 'd1', name: ' People ', content: 'a\n1\n2' },
      [dataset('d1')],
    );
    expect(result.rows).toBe(2);
    expect(calls[0].args).toEqual([
      'dataset.import',
      { workspace: 'w1', id: 'd1', content: 'a\n1\n2' },
    ]);
    expect(calls[1]).toEqual({
      method: 'save',
      args: [{ ...dataset('d1'), name: 'People', value: result }],
    });
  });
  it('requires a dataset before querying or deleting', async () => {
    const data = new DataUseCases(fakeApi().api, () => 'x');
    expect(() => data.queryDataset('w1', '', 'SELECT 1')).toThrowError(
      'Import or choose a dataset first',
    );
    await expect(data.deleteDataset('w1', '')).rejects.toThrowError(
      'Import or choose a dataset first',
    );
  });
  it('records started mocks as workspace documents', async () => {
    const { api, calls } = fakeApi({ 'mock.start': { id: 'm1', port: 9, url: 'http://x' } });
    await new DataUseCases(api, () => 'doc-1').startMock('w1', 0, [{ path: '/a' }]);
    const saved = calls[1].args[0] as WorkspaceDocument;
    expect(saved).toMatchObject({ id: 'doc-1', workspace_id: 'w1', kind: 'mock' });
    expect(saved.value).toEqual({ id: 'm1', port: 9, url: 'http://x', examples: [{ path: '/a' }] });
  });
});

describe('DataUseCases saved mocks', () => {
  it('restarts a saved mock on its port and falls back to a free one', async () => {
    let attempts = 0;
    const { api, calls } = fakeApi();
    (api as { execute: unknown }).execute = async (_: string, payload: { port: number }) => {
      calls.push({ method: 'execute', args: [payload] });
      if (attempts++ === 0) throw new Error('port in use');
      return { id: 'm2', port: 4567, url: 'http://127.0.0.1:4567' };
    };
    const saved = {
      ...dataset('m1'),
      kind: 'mock',
      value: { port: 9999, examples: [{ path: '/a' }] },
    };
    const result = await new DataUseCases(api, () => 'x').restartMock('w1', saved);
    expect(result.port).toBe(4567);
    expect(calls.map((c) => (c.args[0] as { port?: number }).port)).toEqual([9999, 0, undefined]);
    expect((calls.at(-1)!.args[0] as WorkspaceDocument).value).toEqual({
      id: 'm2',
      port: 4567,
      url: 'http://127.0.0.1:4567',
      examples: [{ path: '/a' }],
    });
  });
});

describe('IntegrationUseCases', () => {
  it('builds OAuth token requests with only the fields that apply', async () => {
    const { api, calls } = fakeApi();
    await new IntegrationUseCases(api).exchangeToken('w1', {
      url: 'https://auth.test/token',
      grant: 'refresh_token',
      clientId: 'c',
      clientSecret: 's',
      scope: '',
      code: 'r1',
      redirectUri: '',
      verifier: '',
    });
    expect(calls[0].args).toEqual([
      'oauth.token',
      {
        workspace: 'w1',
        url: 'https://auth.test/token',
        fields: {
          grant_type: 'refresh_token',
          client_id: 'c',
          client_secret: 's',
          scope: '',
          refresh_token: 'r1',
        },
      },
    ]);
  });
  it('sends collection items to code generation and load tests', async () => {
    const { api, calls } = fakeApi({ codegen: { code: 'curl x' } });
    const integration = new IntegrationUseCases(api);
    const request = newRequest('r1');
    request.url = 'https://api.test';
    expect(await integration.generateCode('w1', request, 'cURL', 'cURL')).toBe('curl x');
    await integration.startLoadTest('w1', {
      users: 2,
      duration: 5,
      profile: 'fixed',
      request,
      variables: [],
      globals: [],
      ancestors: [],
    });
    for (const call of calls) {
      const payload = call.args[1] as { request: { request: { url: string } } };
      expect(payload.request.request.url).toBe('https://api.test');
    }
  });
  it('validates secrets and restores revisions over the current one', async () => {
    const { api, calls } = fakeApi();
    const integration = new IntegrationUseCases(api);
    await expect(integration.saveSecret('token', '')).rejects.toThrowError(
      'Enter the secret value',
    );
    expect(() => integration.restoreRevision(dataset('d1'), undefined)).toThrowError(
      'Document no longer exists',
    );
    await integration.restoreRevision(dataset('d1'), { ...dataset('d1'), revision: 9 });
    expect(calls.at(-1)).toEqual({ method: 'save', args: [{ ...dataset('d1'), revision: 9 }] });
  });
});

describe('ProtocolUseCases', () => {
  it('parses gRPC JSON fields and omits an empty CA', async () => {
    const { api, calls } = fakeApi();
    const protocols = new ProtocolUseCases(api);
    await protocols.grpc('w1', {
      url: 'localhost:50051',
      proto: 'syntax = "proto3";',
      service: 's',
      method: 'm',
      tls: false,
      caPem: ' ',
      message: '{"name":"Nexo"}',
      metadata: '',
    });
    expect(calls[0].args).toEqual([
      'grpc',
      {
        workspace: 'w1',
        url: 'localhost:50051',
        proto: 'syntax = "proto3";',
        service: 's',
        method: 'm',
        tls: false,
        message: { name: 'Nexo' },
        metadata: [],
      },
    ]);
    await expect(
      protocols.grpc('w1', {
        url: 'x',
        proto: 'p',
        service: 's',
        method: 'm',
        tls: false,
        message: '{',
        metadata: '',
      }),
    ).rejects.toThrowError('The request message must be valid JSON');
  });
  it('requires an open connection to send', () => {
    const protocols = new ProtocolUseCases(fakeApi().api);
    expect(() =>
      protocols.send('w1', '', { action: 'publish', message: '', topic: '', event: '', qos: 0 }),
    ).toThrowError('Connection is not open');
  });
});
