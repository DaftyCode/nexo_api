import { WorkspaceUseCases } from './workspace-use-cases';
import { ApiPort, FilePort } from './ports';
import { WorkspaceDocument, newRequest } from '../domain/models';
import { emptyVariable } from '../domain/variables';

function fixture() {
  const saved: WorkspaceDocument[] = [];
  const executed: { operation: string; payload: Record<string, unknown> }[] = [];
  const api = {
    async save(document: WorkspaceDocument) {
      const next = { ...document, revision: document.revision + 1 };
      saved.push(next);
      return next;
    },
    async execute<T>(operation: string, payload: Record<string, unknown>) {
      executed.push({ operation, payload });
      return { status: 200 } as T;
    },
  } as unknown as ApiPort;
  let id = 0;
  const files: FilePort = {
    id: () => `id-${++id}`,
    read: async () => '',
    readBase64: async () => '',
    download() {},
  };
  const preferences = new Map<string, string>();
  const cases = new WorkspaceUseCases(api, files, {
    read: (key) => preferences.get(key),
    write: (key, value) => void preferences.set(key, value),
  });
  return { cases, saved, executed, preferences };
}

const document = (kind: string, value: unknown): WorkspaceDocument => ({
  id: `${kind}-1`,
  workspace_id: 'w',
  kind,
  name: kind,
  revision: 3,
  updated_at: 0,
  value,
});

describe('WorkspaceUseCases variables', () => {
  it('sends environment, globals and inherited collection context', async () => {
    const { cases, executed } = fixture();
    const request = newRequest('r');
    request.url = '{{host}}';
    await cases.send(
      request,
      {
        environment: [emptyVariable('host', 'http://x')],
        globals: [{ ...emptyVariable('g', '1'), secret: true }],
        ancestors: [
          { name: 'API', auth: { type: 'bearer' }, variable: [{ key: 'v', value: '{{vault:k}}' }] },
        ],
      },
      'exec-1',
    );
    const payload = executed[0].payload;
    expect(executed[0].operation).toBe('request');
    expect(payload['variables']).toEqual([{ key: 'host', value: 'http://x', enabled: true }]);
    expect(payload['globals']).toEqual([{ key: 'g', value: '1', enabled: true, type: 'secret' }]);
    expect(payload['context']).toEqual({
      ancestors: [
        { name: 'API', auth: { type: 'bearer' }, variable: [{ key: 'v', value: '{{vault:k}}' }] },
      ],
    });
    expect(payload['secretNames']).toBeUndefined();
  });

  it('sends the chosen files apart from the request and reads them in base64', async () => {
    const { cases, executed } = fixture();
    const request = newRequest('r');
    request.url = 'http://x';
    request.method = 'POST';
    request.bodyMode = 'file';
    request.bodyFile = {
      src: 'a.bin',
      file: { name: 'a.bin', contentType: 'application/octet-stream', size: 1, content: 'AQ==' },
    };
    await cases.send(request, { environment: [], globals: [], ancestors: [] }, 'exec-2');
    const payload = executed[0].payload;
    expect(payload['files']).toEqual([
      { src: 'a.bin', content: 'AQ==', contentType: 'application/octet-stream' },
    ]);
    expect(JSON.stringify(payload['request'])).not.toContain('AQ==');
    request.bodyMode = 'raw';
    await cases.send(request, { environment: [], globals: [], ancestors: [] }, 'exec-3');
    expect(executed[1].payload['files']).toBeUndefined();

    const big = new File(['x'], 'big.bin');
    Object.defineProperty(big, 'size', { value: 32 * 1024 * 1024 + 1 });
    await expect(cases.attachFile(big)).rejects.toThrow('can add up to 32 MB');
  });

  it('remembers the active environment per workspace', () => {
    const { cases } = fixture();
    expect(cases.rememberedEnvironment('w')).toBe('');
    cases.rememberEnvironment('w', 'env-1');
    expect(cases.rememberedEnvironment('w')).toBe('env-1');
    expect(cases.rememberedEnvironment('other')).toBe('');
  });

  it('persists only the scopes that scripts changed', async () => {
    const { cases, saved } = fixture();
    const environment = document('environment', {
      name: 'Dev',
      values: [{ key: 'a', value: '1', enabled: true }],
    });
    const collection = document('collection', {
      info: { name: 'API', schema: 's' },
      item: [],
      variable: [{ key: 'c', value: 'same' }],
      auth: { type: 'bearer', bearer: [] },
    });
    const result = await cases.persistScriptVariables(
      {
        environment: { values: [{ key: 'a', value: '2' }] },
        globals: { values: [] },
        collection: [{ key: 'c', value: 'same' }],
      },
      { workspace: 'w', environment, collection },
    );
    expect(result).toHaveLength(1);
    expect(saved[0].id).toBe('environment-1');
    expect(saved[0].value).toEqual({
      name: 'environment',
      values: [{ key: 'a', value: '2', enabled: true }],
    });
  });

  it('creates the globals document on the first script write and keeps collection auth', async () => {
    const { cases, saved } = fixture();
    const collection = document('collection', {
      info: { name: 'API', schema: 's' },
      item: [],
      auth: { type: 'bearer', bearer: [] },
    });
    await cases.persistScriptVariables(
      { globals: { values: [{ key: 'g', value: 'x' }] }, collection: [{ key: 'n', value: '1' }] },
      { workspace: 'w', collection },
    );
    expect(saved.map((d) => d.kind)).toEqual(['globals', 'collection']);
    expect(saved[0].value).toEqual({
      name: 'Globals',
      values: [{ key: 'g', value: 'x', enabled: true }],
    });
    expect(saved[1].value).toMatchObject({
      variable: [{ key: 'n', value: '1' }],
      auth: { type: 'bearer', bearer: [] },
    });
  });

  it('saves folder settings in the folder and leaves the collection root alone', async () => {
    const { cases, saved } = fixture();
    const rootAuth = { type: 'bearer', bearer: [{ key: 'token', value: 'root' }] };
    const collection = document('collection', {
      info: { name: 'API', schema: 's' },
      auth: rootAuth,
      item: [{ name: 'Local', auth: rootAuth, item: [{ name: 'Request', request: {} }] }],
    });
    const folderAuth = { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }] };
    await cases.saveCollectionSettings(
      collection,
      { variables: [emptyVariable('host', 'localhost')], auth: folderAuth },
      [0],
    );
    const value = saved[0].value as { auth: unknown; item: Record<string, unknown>[] };
    expect(value.auth).toEqual(rootAuth);
    expect(value.item[0]).toMatchObject({
      name: 'Local',
      auth: folderAuth,
      variable: [{ key: 'host', value: 'localhost' }],
    });
    // Inheriting again removes the folder's own authorization and empty variables.
    await cases.saveCollectionSettings(saved[0], { variables: [emptyVariable()] }, [0]);
    const inherited = saved[1].value as { item: Record<string, unknown>[] };
    expect(inherited.item[0]['auth']).toBeUndefined();
    expect(inherited.item[0]['variable']).toBeUndefined();
    // The original document is not modified in place.
    expect((collection.value as { item: { auth: unknown }[] }).item[0].auth).toEqual(rootAuth);
    await expect(
      cases.saveCollectionSettings(collection, { variables: [] }, [0, 0]),
    ).rejects.toThrow('Folder not found');
  });
});

describe('WorkspaceUseCases OAuth 2.0 sign-in', () => {
  it('opens the system browser when there is no sign-in window (web version)', async () => {
    const { cases, executed } = fixture();
    expect(cases.hasSignInWindow).toBe(false);
    await cases.oauth2Authorize(
      { type: 'oauth2' },
      { environment: [], globals: [], ancestors: [] },
    );
    expect(executed[0]).toMatchObject({
      operation: 'oauth2.authorize',
      payload: { action: 'start', openBrowser: true },
    });
  });
});
