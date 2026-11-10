import { signal } from '@angular/core';
import { WorkspaceUseCases } from '../../application/workspace-use-cases';
import { ApiFailure } from '../../application/ports';
import { RequestDraft, WorkspaceDocument, asCollection, newRequest } from '../../domain/models';
import { RequestsStore } from './requests-store';
import { TabsStore } from '../tabs-store';
import { CollectionsStore } from './collections-store';
import { DocumentsStore } from './documents-store';
import { SessionStore } from './session-store';
import { StateContext, StatusStore } from './state-context';
import { VariablesStore } from './variables-store';

const document = (
  id: string,
  kind: string,
  updated = 0,
  value: unknown = {},
): WorkspaceDocument => ({
  id,
  workspace_id: 'w1',
  kind,
  name: id,
  revision: 1,
  updated_at: updated,
  value,
});

/** A context whose use cases are replaced by the given functions. */
function context(cases: Partial<Record<keyof WorkspaceUseCases, unknown>>, confirm = true) {
  let next = 0;
  const value: StateContext = {
    cases: { files: { id: () => `id${++next}` }, ...cases } as unknown as WorkspaceUseCases,
    status: new StatusStore(),
    tabs: new TabsStore(() => `t${++next}`),
    workspaceId: signal('w1'),
    section: signal('collections'),
    confirm: () => confirm,
  };
  return value;
}

describe('workspace stores', () => {
  it('apply saves locally and prune old history', async () => {
    const removed: string[] = [];
    const ctx = context({ removeDocument: async (d: WorkspaceDocument) => removed.push(d.id) });
    const documents = new DocumentsStore(ctx);
    documents.documents.set([document('h1', 'history', 1), document('h2', 'history', 2)]);
    documents.applySaved([document('c1', 'collection'), { ...document('h2', 'history', 3) }]);
    expect(documents.collections().map((d) => d.id)).toEqual(['c1']);
    await documents.pruneHistory(1);
    expect(removed).toEqual(['h1']);
    expect(documents.history().map((d) => d.id)).toEqual(['h2']);
  });

  it('remember the environment per workspace and forget deleted ones', () => {
    const remembered = new Map<string, string>();
    const ctx = context({
      rememberEnvironment: (w: string, id: string) => remembered.set(w, id),
      rememberedEnvironment: (w: string) => remembered.get(w),
    });
    const documents = new DocumentsStore(ctx);
    const variables = new VariablesStore(ctx, documents);
    documents.documents.set([
      document('dev', 'environment', 0, { values: [{ key: 'a', value: '1', enabled: true }] }),
    ]);
    variables.select('dev');
    expect(variables.environmentRows().map((r) => r.key)).toEqual(['a']);
    variables.environmentId.set('');
    variables.restore();
    expect(variables.environmentId()).toBe('dev');
    documents.documents.set([]);
    variables.validate();
    expect(variables.environmentId()).toBe('');
  });

  it('rename the open tab of a renamed request, so saving it keeps the new name', async () => {
    const saved: WorkspaceDocument[] = [];
    const ctx = context({
      saveDocument: async (d: WorkspaceDocument) => (saved.push(d), d),
      saveRequest: (d: WorkspaceDocument, path: number[], request: RequestDraft) =>
        new WorkspaceUseCases(
          { save: async (next: WorkspaceDocument) => (saved.push(next), next) } as never,
          { id: () => 'x' } as never,
        ).saveRequest(d, path, request),
    });
    const documents = new DocumentsStore(ctx);
    const collections = new CollectionsStore(ctx, documents);
    const shop = document('shop', 'collection', 0, {
      info: { name: 'Shop' },
      item: [{ id: 'r1', name: 'New request', request: { method: 'GET', url: 'http://x' } }],
    });
    documents.documents.set([shop]);
    collections.open(shop, asCollection(shop.value).item[0], [0]);
    await collections.change(shop, (tree, value) => tree.renameItem(value, [0], 'List orders'));
    expect(ctx.tabs.active()?.request.name).toBe('List orders');
    expect(ctx.tabs.active()?.dirty).toBe(false);

    ctx.tabs.edit({ ...ctx.tabs.active()!.request, url: 'http://y' });
    await collections.saveActive();
    expect(asCollection(saved.at(-1)!.value).item[0].name).toBe('List orders');
  });

  it('save variables over a version changed elsewhere only when confirmed', async () => {
    const conflict = new ApiFailure('Revision conflict', 'conflict', 409);
    const globals = document('g', 'globals', 0, { values: [] });
    let attempts = 0;
    let answer = true;
    const ctx = context({
      saveGlobals: async (_w: string, existing: WorkspaceDocument) => {
        if (++attempts === 1) throw conflict;
        return { ...existing, revision: existing.revision + 1 };
      },
      documents: async () => [{ ...globals, revision: 5 }],
    });
    ctx.confirm = () => answer;
    const documents = new DocumentsStore(ctx);
    documents.documents.set([globals]);
    const variables = new VariablesStore(ctx, documents);
    const saved = await variables.saveGlobals([]);
    expect(saved?.revision).toBe(6);
    expect(documents.globalsDocument()?.revision).toBe(6);

    attempts = 0;
    answer = false;
    expect(await variables.saveGlobals([])).toBeUndefined();
    expect(ctx.status.notice()).toBe('Variables reloaded');
    expect(documents.globalsDocument()?.revision).toBe(5);
    const failing = context({
      saveGlobals: async () => {
        throw new Error('disk full');
      },
    });
    await expect(
      new VariablesStore(failing, new DocumentsStore(failing)).saveGlobals([]),
    ).rejects.toThrow('disk full');
  });

  it('send each tab on its own and give each response to the tab that sent it', async () => {
    const answers: ((value: unknown) => void)[] = [];
    const sent: string[] = [];
    const ctx = context({
      send: (request: RequestDraft) => {
        sent.push(request.url);
        return new Promise((resolve) => answers.push(resolve));
      },
      persistScriptVariables: async () => [],
      createDocument: async () => document('h', 'history'),
      execute: async (_w: string, operation: string, payload: Record<string, unknown>) => {
        sent.push(`${operation} ${String(payload['id'])}`);
        return {};
      },
    });
    const documents = new DocumentsStore(ctx);
    const variables = new VariablesStore(ctx, documents);
    const requests = new RequestsStore(
      ctx,
      documents,
      variables,
      new CollectionsStore(ctx, documents),
    );
    const response = (body: string) => ({
      status: 200,
      statusText: 'OK',
      body,
      headers: [],
      time: 1,
      size: 1,
      assertions: [],
      logs: [],
    });
    const first = ctx.tabs.open({ ...newRequest('a'), url: 'http://a' });
    const sending = requests.send();
    expect(requests.running()).toBe(true);
    // While the first waits, the second tab is not busy and sends too.
    const second = ctx.tabs.open({ ...newRequest('b'), url: 'http://b' });
    expect(requests.running()).toBe(false);
    const other = requests.send();
    expect(sent).toEqual(['http://a', 'http://b']);
    // Sending the same tab twice does nothing.
    await requests.send();
    expect(sent).toHaveLength(2);

    answers[0](response('from a'));
    await sending;
    expect(ctx.tabs.response()).toBeUndefined();
    expect(requests.running()).toBe(true);
    ctx.tabs.activeId.set(first);
    expect(ctx.tabs.response()?.body).toBe('from a');
    expect(requests.running()).toBe(false);

    ctx.tabs.activeId.set(second);
    await requests.cancel();
    expect(sent.at(-1)).toMatch(/^cancel id/);
    expect(requests.running()).toBe(false);
    answers[1](response('from b'));
    await other;
    expect(ctx.tabs.response()?.body).toBe('from b');
    await requests.cancel();
    expect(sent.filter((call) => call.startsWith('cancel'))).toHaveLength(1);
  });

  it('switch workspaces only after confirming unsaved changes', async () => {
    const ctx = context(
      { documents: async () => [], rememberedEnvironment: () => undefined },
      false,
    );
    const documents = new DocumentsStore(ctx);
    const session = new SessionStore(ctx, documents, new VariablesStore(ctx, documents));
    ctx.tabs.open();
    ctx.tabs.edit({ ...ctx.tabs.active()!.request, url: 'http://x' });
    await session.select('w2');
    expect(ctx.workspaceId()).toBe('w1');
    ctx.tabs.tabs.update((tabs) => tabs.map((t) => ({ ...t, dirty: false })));
    await session.select('w2');
    expect(ctx.workspaceId()).toBe('w2');
    expect(ctx.tabs.tabs().length).toBe(1);
  });
});
