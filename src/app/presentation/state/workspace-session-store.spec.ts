import { signal } from '@angular/core';
import { ApiPort, PreferencePort } from '../../application/ports';
import { SessionCases, WorkspaceUseCases } from '../../application/workspace-use-cases';
import { WorkspaceDocument } from '../../domain/models';
import { TabsStore } from '../tabs-store';
import { DocumentsStore } from './documents-store';
import { SessionStore } from './session-store';
import { StateContext, StatusStore } from './state-context';
import { VariablesStore } from './variables-store';
import { SESSION_SAVE_DELAY, WorkspaceSessionStore } from './workspace-session-store';

const collection = (id: string, names: string[]): WorkspaceDocument => ({
  id,
  workspace_id: 'w1',
  kind: 'collection',
  name: id,
  revision: 1,
  updated_at: 0,
  value: {
    info: { name: id, schema: 'x' },
    item: names.map((name) => ({ id: name, name, request: { method: 'GET', url: name } })),
  },
});

/** An engine that keeps documents, as the stores see it after a reload of the page. */
function engine() {
  const stored: WorkspaceDocument[] = [collection('c1', ['a', 'b']), collection('c2', ['c'])];
  const saves: WorkspaceDocument[] = [];
  const api = {
    async save(document: WorkspaceDocument) {
      saves.push(document);
      const saved = { ...document, revision: document.revision + 1 };
      const index = stored.findIndex((d) => d.id === document.id);
      if (index < 0) stored.push(saved);
      else stored[index] = saved;
      return saved;
    },
    async document(id: string) {
      return stored.find((d) => d.id === id)!;
    },
  } as unknown as ApiPort;
  const values = new Map<string, string>();
  const preferences: PreferencePort = {
    read: (key) => values.get(key),
    write: (key, value) => void (value ? values.set(key, value) : values.delete(key)),
  };
  return { stored, saves, api, preferences };
}

/** The stores of one page of the app, opened on the engine's documents. */
function page(server: ReturnType<typeof engine>) {
  let next = 0;
  const context: StateContext = {
    cases: {
      files: { id: () => `id${++next}` },
      documents: async () => [...server.stored],
      sessions: new SessionCases(server.api, server.preferences),
      variables: { rememberedEnvironment: () => undefined },
    } as unknown as WorkspaceUseCases,
    status: new StatusStore(),
    tabs: new TabsStore(() => `t${++next}`),
    workspaceId: signal('w1'),
    section: signal('collections'),
    confirm: () => true,
  };
  const documents = new DocumentsStore(context);
  const opened = new WorkspaceSessionStore(context, documents);
  const session = new SessionStore(
    context,
    documents,
    new VariablesStore(context, documents),
    opened,
  );
  return { context, documents, opened, session };
}

describe('workspace session store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reopens tabs, unsaved changes, the section and the collection order', async () => {
    const server = engine();
    const first = page(server);
    await first.session.select('w1');
    // Nothing stored yet: a blank tab, and the collections as the engine lists them.
    expect(first.context.tabs.tabs()).toHaveLength(1);
    first.context.tabs.close(first.context.tabs.tabs()[0].id);
    const a = first.context.tabs.open(undefined, 'c1', [0]);
    first.context.tabs.open(undefined, 'c2', [0]);
    first.context.tabs.edit({ ...first.context.tabs.active()!.request, url: 'http://changed' });
    first.context.tabs.move(first.context.tabs.activeId(), 0);
    first.context.tabs.activeId.set(a);
    first.context.section.set('mongo');
    first.opened.moveCollection('c2', 0);
    expect(first.documents.collections().map((d) => d.id)).toEqual(['c2', 'c1']);
    first.opened.changed();
    expect(server.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY);
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]).toEqual(
      expect.objectContaining({ id: 'session-w1', kind: 'session', revision: 0 }),
    );
    // The same session is not saved twice.
    first.opened.changed();
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY);
    expect(server.saves).toHaveLength(1);

    const second = page(server);
    await second.session.select('w1');
    expect(second.documents.collections().map((d) => d.id)).toEqual(['c2', 'c1']);
    expect(second.documents.documents().some((d) => d.kind === 'session')).toBe(false);
    const tabs = second.context.tabs.tabs();
    expect(tabs.map((t) => [t.documentId, t.path, t.dirty])).toEqual([
      ['c2', [0], true],
      ['c1', [0], false],
    ]);
    expect(tabs[0].request.url).toBe('http://changed');
    expect(tabs[1].request.name).toBe('a');
    expect(second.context.tabs.activeId()).toBe(tabs[1].id);
    expect(second.context.section()).toBe('mongo');
  });

  it('keeps only the collection order when tabs do not reopen, and says what was dropped', async () => {
    const server = engine();
    server.stored.push({
      id: 'session-w1',
      workspace_id: 'w1',
      kind: 'session',
      name: 'Session',
      revision: 3,
      updated_at: 0,
      value: {
        tabs: [
          { id: 'gone', documentId: 'c1', path: [5], itemId: 'zz', itemName: 'zz' },
          { id: 'kept', documentId: 'c1', path: [1], itemId: 'b', itemName: 'b' },
        ],
        activeTab: 'gone',
        collections: ['deleted', 'c2', 'c1'],
      },
    });
    const reopened = page(server);
    await reopened.session.select('w1');
    expect(reopened.context.tabs.tabs().map((t) => t.id)).toEqual(['kept']);
    expect(reopened.context.status.toast()?.params).toEqual({ v0: '1' });

    const off = page(server);
    off.opened.setRestoresTabs(false);
    await off.session.select('w1');
    expect(off.context.tabs.tabs().map((t) => t.request.name)).toEqual(['Untitled request']);
    expect(off.documents.collections().map((d) => d.id)).toEqual(['c2', 'c1']);
    await off.opened.flush();
    expect(server.saves.at(-1)?.value).toEqual(
      expect.objectContaining({ tabs: [], collections: ['c2', 'c1'] }),
    );
    expect(server.saves.at(-1)?.revision).toBe(3);
  });
});
