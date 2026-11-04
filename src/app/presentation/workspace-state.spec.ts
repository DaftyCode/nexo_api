import { TestBed } from '@angular/core/testing';
import { testProviders } from '../testing/providers';
import { WORKSPACE } from '../composition/providers';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { ApiFailure, ApiPort, FilePort } from '../application/ports';
import { WorkspaceDocument } from '../domain/models';
import { WorkspaceState } from './workspace-state';

const environment: WorkspaceDocument = {
  id: 'dev',
  workspace_id: 'local',
  kind: 'environment',
  name: 'Dev',
  revision: 1,
  updated_at: 1,
  value: { name: 'Dev', values: [{ key: 'host', value: 'http://dev', enabled: true }] },
};
const collection: WorkspaceDocument = {
  id: 'api',
  workspace_id: 'local',
  kind: 'collection',
  name: 'API',
  revision: 1,
  updated_at: 1,
  value: {
    info: { name: 'API', schema: 's' },
    variable: [{ key: 'version', value: 'v1' }],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 't' }] },
    item: [{ name: 'Users', request: { method: 'GET', url: '{{host}}/{{version}}/users' } }],
  },
};

function setup() {
  let documents = [environment, collection];
  const executed: { operation: string; payload: Record<string, unknown> }[] = [];
  const preferences = new Map<string, string>();
  const api = {
    async initialize() {},
    async health() {
      return { name: 'Nexo', version: 't', mode: 'desktop', engineReady: true };
    },
    async workspaces() {
      return [{ id: 'local', name: 'Local' }];
    },
    async documents() {
      return documents;
    },
    async save(document: WorkspaceDocument) {
      const next = { ...document, revision: document.revision + 1 };
      documents = [...documents.filter((d) => d.id !== next.id), next];
      return next;
    },
    async execute<T>(operation: string, payload: Record<string, unknown>) {
      executed.push({ operation, payload });
      return {
        status: 200,
        statusText: 'OK',
        body: '{}',
        headers: [],
        time: 1,
        size: 2,
        assertions: [],
        logs: [],
        variables: {
          environment: {
            values: [
              { key: 'host', value: 'http://dev' },
              { key: 'token', value: 'abc' },
            ],
          },
          globals: { values: [] },
          collection: [{ key: 'version', value: 'v1' }],
        },
      } as T;
    },
  } as unknown as ApiPort;
  let id = 0;
  const files: FilePort = { id: () => `id-${++id}`, read: async () => '', download() {} };
  const cases = new WorkspaceUseCases(api, files, {
    read: (key) => preferences.get(key),
    write: (key, value) => void preferences.set(key, value),
  });
  TestBed.configureTestingModule({
    providers: [...testProviders(), { provide: WORKSPACE, useValue: cases }],
  });
  return {
    state: TestBed.inject(WorkspaceState),
    executed,
    preferences,
    documents: () => documents,
  };
}

describe('WorkspaceState variables', () => {
  it('restores the environment remembered for the workspace', async () => {
    const { state, preferences } = setup();
    preferences.set('environment.local', 'dev');
    await state.initialize();
    expect(state.environmentId()).toBe('dev');
    state.selectEnvironment('');
    expect(preferences.get('environment.local')).toBe('');
    state.selectEnvironment('missing');
    expect(state.environmentId()).toBe('');
  });

  it('resolves the variables of a request opened from a collection', async () => {
    const { state } = setup();
    await state.initialize();
    state.selectEnvironment('dev');
    const value = collection.value as { item: { name: string }[] };
    state.openItem(collection, value.item[0] as never, [0]);
    const resolved = Object.fromEntries(state.activeVariables().map((v) => [v.name, v.scope]));
    expect(resolved).toEqual({ host: 'environment', version: 'collection' });
  });

  it('sends the collection context and saves variables changed by scripts', async () => {
    const { state, executed, documents } = setup();
    await state.initialize();
    state.selectEnvironment('dev');
    const value = collection.value as { item: { name: string }[] };
    state.openItem(collection, value.item[0] as never, [0]);
    await state.send();
    const request = executed.find((entry) => entry.operation === 'request')!;
    expect(request.payload['variables']).toEqual([
      { key: 'host', value: 'http://dev', enabled: true },
    ]);
    expect(
      (request.payload['context'] as { ancestors: { name: string }[] }).ancestors[0].name,
    ).toBe('API');
    const savedEnvironment = documents().find((d) => d.id === 'dev')!;
    expect(savedEnvironment.revision).toBe(2);
    expect(
      (savedEnvironment.value as { values: { key: string }[] }).values.map((r) => r.key),
    ).toEqual(['host', 'token']);
    expect(documents().some((d) => d.kind === 'history')).toBe(true);
    expect(state.error()).toBe('');
  });
});

describe('WorkspaceState startup', () => {
  it('shows the sign-in screen when the session is missing', async () => {
    const { state } = setup();
    state.cases.workspaces = async () => {
      throw new ApiFailure('Authentication required', 'unauthorized', 401);
    };
    await state.initialize();
    expect(state.ready()).toBe(true);
    expect(state.authenticated()).toBe(false);
    expect(state.error()).toBe('');
  });

  it('keeps the startup screen with an error when the backend is unreachable', async () => {
    const { state } = setup();
    state.cases.workspaces = async () => {
      throw new ApiFailure('Cannot reach', 'unreachable', 0);
    };
    await state.initialize();
    expect(state.ready()).toBe(false);
    expect(state.error()).toBe('error.unreachable');
  });
});

describe('WorkspaceState collection tree', () => {
  it('keeps an open request on its item when the tree changes', async () => {
    const { state } = setup();
    state.confirm = () => true;
    await state.initialize();
    const api = () => state.collections().find((d) => d.id === 'api')!;
    await state.addFolder(api(), 'Folder');
    const users = (api().value as { item: { name: string }[] }).item[0];
    state.openItem(api(), users, [0]);
    const tab = state.active()!;
    await state.moveItem(api(), [0], [1]);
    expect(state.active()?.path).toEqual([0, 0]);
    expect(state.active()?.documentId).toBe('api');
    await state.renameItem(api(), [0], 'Renamed');
    expect((api().value as { item: { name: string }[] }).item[0].name).toBe('Renamed');
    await state.removeItem(api(), [0]);
    const detached = state.tabs().find((t) => t.id === tab.id)!;
    expect(detached.documentId).toBe('');
    expect(state.error()).toBe('');
  });
});
