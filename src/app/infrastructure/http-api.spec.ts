import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { vi } from 'vitest';
import { ApiFailure } from '../application/ports';
import { WorkspaceDocument } from '../domain/models';
import { HttpApi } from './http-api';

const document: WorkspaceDocument = {
  id: 'd/1',
  workspace_id: 'local',
  kind: 'collection',
  name: 'Shop',
  revision: 3,
  updated_at: 0,
  value: {},
};

describe('HttpApi', () => {
  let api: HttpApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [HttpApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(HttpApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  /** Starts a call, answers its single request and returns both. */
  async function call<T>(start: () => Promise<T>, answer: object = {}) {
    const pending = start();
    await Promise.resolve();
    const request = http.expectOne(() => true);
    request.flush(answer);
    return { result: await pending, request: request.request };
  }

  it('sends every call to the local API with the client header', async () => {
    await api.initialize();
    const cases: [() => Promise<unknown>, string, string, unknown?][] = [
      [() => api.health(), 'GET', '/api/health'],
      [() => api.signOut(), 'POST', '/api/session/close', {}],
      [() => api.workspaces(), 'GET', '/api/workspaces'],
      [() => api.createWorkspace('Team'), 'POST', '/api/workspaces', { name: 'Team' }],
      [() => api.renameWorkspace('a b', 'Ops'), 'PUT', '/api/workspaces/a%20b', { name: 'Ops' }],
      [() => api.deleteWorkspace('a b'), 'DELETE', '/api/workspaces/a%20b'],
      [() => api.document('d/1'), 'GET', '/api/documents/d%2F1'],
      [() => api.save(document), 'PUT', '/api/documents', document],
      [() => api.remove(document), 'DELETE', '/api/documents/d%2F1?revision=3'],
      [
        () => api.execute('codegen', { workspace: 'local' } as never),
        'POST',
        '/api/execute/codegen',
        { workspace: 'local' },
      ],
      [
        () => api.git('status', { workspace: 'local' }),
        'POST',
        '/api/git/status',
        { workspace: 'local' },
      ],
      [() => api.revisions('d/1'), 'GET', '/api/documents/d%2F1/revisions'],
      [
        () => api.putSecret('api key', 'v', ['a.com']),
        'PUT',
        '/api/secrets/api%20key',
        { value: 'v', allowedHosts: ['a.com'] },
      ],
      [() => api.removeSecret('api key'), 'DELETE', '/api/secrets/api%20key'],
    ];
    for (const [start, method, url, body] of cases) {
      const { request } = await call(start);
      expect([request.method, request.urlWithParams]).toEqual([method, url]);
      expect(request.headers.get('x-nexo-client')).toBe('nexo');
      expect(request.headers.has('Authorization')).toBe(false);
      if (body !== undefined) expect(request.body).toEqual(body);
    }
  });

  it('lists documents and secrets and rejects a malformed workspace', async () => {
    const listed = await call(() => api.documents('my space'), [document]);
    expect(listed.request.urlWithParams).toBe('/api/documents?workspace=my%20space&lite=true');
    expect(listed.result).toEqual([document]);
    await expect(call(() => api.documents('local'), [{ id: 1 }])).rejects.toThrow(
      'Invalid workspace response',
    );
    await expect(call(() => api.documents('local'), { not: 'a list' })).rejects.toThrow(
      'Invalid workspace response',
    );
    expect(
      (await call(() => api.secrets(), { secrets: [{ name: 'a', allowedHosts: [] }] })).result,
    ).toEqual([{ name: 'a', allowedHosts: [] }]);
    expect((await call(() => api.secrets(), {})).result).toEqual([]);
  });

  it('turns failed calls into stable errors', async () => {
    const fail = async (status: number, body: object | null) => {
      const pending = api.health();
      await Promise.resolve();
      const request = http.expectOne('/api/health');
      if (status === 0) request.error(new ProgressEvent('error'), { status: 0 });
      else request.flush(body, { status, statusText: 'Error' });
      return pending.then(
        () => undefined,
        (error: unknown) => error as ApiFailure,
      );
    };
    const unreachable = await fail(0, null);
    expect([unreachable?.code, unreachable?.status]).toEqual(['unreachable', 0]);
    expect(unreachable?.message).toContain('Cannot reach the Nexo backend');
    const conflict = await fail(409, { error: 'Revision conflict', code: 'conflict' });
    expect([conflict?.message, conflict?.code, conflict?.status]).toEqual([
      'Revision conflict',
      'conflict',
      409,
    ]);
    const plain = await fail(500, null);
    expect([plain?.message, plain?.code]).toEqual(['Request failed (500)', 'http']);
    // A database's error keeps where it failed, for the editor to mark it.
    const syntax = await fail(400, {
      error: 'syntax error at or near "form"',
      code: 'database.syntax',
      detail: { position: 10 },
    });
    expect([syntax?.code, syntax?.detail]).toEqual(['database.syntax', { position: 10 }]);
  });

  it('sends an operation as the page goes with a request that outlives it', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('The page is gone');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      api.executeOnExit('db.disconnect', { session: 'tree:c1', workspace: 'w' });
      // The desktop window sends its token to the service's address.
      Object.assign(api, { base: 'http://127.0.0.1:5000', token: 'run-token' });
      api.executeOnExit('db.disconnect', { session: 'editor:t1' });
      await Promise.resolve();
      expect(fetch.mock.calls).toEqual([
        [
          '/api/execute/db.disconnect',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-nexo-client': 'nexo' },
            body: '{"session":"tree:c1","workspace":"w"}',
            keepalive: true,
          },
        ],
        [
          'http://127.0.0.1:5000/api/execute/db.disconnect',
          expect.objectContaining({
            headers: {
              'content-type': 'application/json',
              'x-nexo-client': 'nexo',
              authorization: 'Bearer run-token',
            },
            keepalive: true,
          }),
        ],
      ]);
      // Without fetch there is nothing to send it with.
      vi.stubGlobal('fetch', undefined);
      expect(() => api.executeOnExit('db.disconnect', { session: 's' })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
