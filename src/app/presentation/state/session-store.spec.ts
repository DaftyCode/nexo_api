import { signal } from '@angular/core';
import { PreferencePort } from '../../application/ports';
import { SessionCases, WorkspaceUseCases } from '../../application/workspace-use-cases';
import { TabsStore } from '../tabs-store';
import { DocumentsStore } from './documents-store';
import { SessionStore } from './session-store';
import { StateContext, StatusStore } from './state-context';
import { VariablesStore } from './variables-store';

/** One page of the app on a device whose preferences outlive it. */
function page(values: Map<string, string>, workspaces = ['creative', 'mine']) {
  const preferences: PreferencePort = {
    read: (key) => values.get(key),
    write: (key, value) => void (value ? values.set(key, value) : values.delete(key)),
  };
  let next = 0;
  const context: StateContext = {
    cases: {
      initialize: async () => undefined,
      health: async () => ({ status: 'ok' }),
      workspaces: async () => workspaces.map((id) => ({ id, name: id })),
      documents: async () => [],
      files: { id: () => `id${++next}` },
      sessions: new SessionCases({} as never, preferences),
      variables: { rememberedEnvironment: () => undefined },
    } as unknown as WorkspaceUseCases,
    status: new StatusStore(),
    tabs: new TabsStore(() => `t${++next}`),
    workspaceId: signal(''),
    section: signal('collections'),
    confirm: () => true,
  };
  const documents = new DocumentsStore(context);
  const session = new SessionStore(context, documents, new VariablesStore(context, documents));
  return { context, session };
}

describe('SessionStore', () => {
  it('opens the workspace used last on this device, or the first when it is gone', async () => {
    const device = new Map<string, string>();
    const first = page(device);
    await first.session.initialize();
    expect(first.context.workspaceId()).toBe('creative');
    await first.session.select('mine');

    const again = page(device);
    await again.session.initialize();
    expect(again.context.workspaceId()).toBe('mine');

    const gone = page(device, ['creative']);
    await gone.session.initialize();
    expect(gone.context.workspaceId()).toBe('creative');
  });
});
