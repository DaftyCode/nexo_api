import { signal } from '@angular/core';
import { WorkspaceUseCases } from '../../application/workspace-use-cases';
import { WorkspaceDocument } from '../../domain/models';
import { TabsStore } from '../tabs-store';
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
