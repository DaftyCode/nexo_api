import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../../application/ports';
import type { NavigatorRow } from '../../domain/db/rows';
import type { WorkspaceDocument } from '../../domain/models';
import { DbActions } from './actions';
import type { DbSection } from './section';

const shop: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'w',
  kind: 'connection',
  name: 'Shop',
  revision: 1,
  updated_at: 0,
  value: { driver: 'postgres' },
};
const row = (extra: Partial<NavigatorRow>): NavigatorRow =>
  ({
    key: 'k',
    type: 'node',
    level: 1,
    label: 'x',
    expandable: false,
    expanded: false,
    ...extra,
  }) as NavigatorRow;

function fixture(options: { document?: WorkspaceDocument; update?: () => Promise<unknown> } = {}) {
  const done: string[] = [];
  const toasts: unknown[] = [];
  const documents = signal<WorkspaceDocument[]>(options.document ? [options.document] : []);
  const cases = {
    connections: {
      update: options.update ?? (async () => ({})),
      moveTo: options.update ?? (async () => ({})),
    },
  };
  const section = {
    connection: (id: string) => documents().find((document) => document.id === id),
    cases: async () => cases,
    scripts: () => [],
    connections: () => documents(),
    tabs: { tabs: () => [{ id: 't1', connection: 'c2' }], open: () => void done.push('tab') },
    tree: {
      toggleFolder: () => void done.push('folder'),
      collapse: () => void done.push('collapse'),
      expand: async () => void done.push('expand'),
      disconnect: async () => void done.push('disconnect'),
      reconnect: async () => void done.push('reconnect'),
      refresh: async () => void done.push('refresh'),
    },
    schema: { clear: () => void done.push('clear') },
    openScript: () => void done.push('script'),
    openObject: () => void done.push('object'),
    newScript: () => void done.push('new'),
    edit: () => void done.push('edit'),
    closeTab: () => void done.push('close'),
    bookmarks: signal([]),
    state: {
      confirm: () => false,
      refresh: async () => undefined,
      tell: (toast: unknown) => void toasts.push(toast),
      describe: (error: unknown) => (error as Error).message,
    },
  } as unknown as DbSection;
  return { actions: new DbActions(section), done, toasts, documents };
}

describe('the actions of the navigator, at their edges', () => {
  it('does nothing for a row whose connection is gone or that cannot do it', async () => {
    const { actions, done } = fixture();
    const lost = row({ connection: 'gone', type: 'connection', expandable: true });
    await actions.toggle(lost);
    await actions.connect(lost);
    await actions.disconnect(row({}));
    await actions.reconnect(lost);
    await actions.refresh(lost);
    actions.open(row({ type: 'node', node: { actions: [] } as never }));
    actions.newScript(row({}));
    actions.console(row({}));
    actions.deleteScript(row({ script: 'none' }));
    actions.edit(lost);
    actions.duplicate(lost);
    actions.rename(lost);
    actions.moveTo(lost);
    actions.remove(lost);
    actions.filter(lost);
    actions.answer({ first: '', second: '' } as never);
    actions.bookmark(row({}));
    actions.bookmark(row({ connection: 'c1', type: 'folder' }));
    expect(done).toEqual([]);
    expect(actions.dialog()).toBeUndefined();
  });

  it('toggles folders and scripts, refreshes only connections and nodes', async () => {
    const { actions, done } = fixture({ document: shop });
    await actions.toggle(row({ type: 'scripts' }));
    await actions.toggle(
      row({ type: 'connection', connection: 'c1', expandable: true, expanded: true }),
    );
    await actions.toggle(row({ type: 'connection', connection: 'c1', expandable: true }));
    await actions.toggle(row({ type: 'connection', connection: 'c1' }));
    await actions.refresh(row({ type: 'folder', connection: 'c1' }));
    await actions.refresh(row({ type: 'node', connection: 'c1' }));
    actions.rename(row({ connection: 'c1', type: 'node' }));
    actions.remove(row({ connection: 'c1', type: 'node' }));
    actions.filter(row({ connection: 'c1', type: 'folder', expandable: true }));
    actions.bookmark(row({ connection: 'c1', node: { kind: 'table' } as never }));
    expect(done).toEqual(['folder', 'collapse', 'expand', 'clear', 'refresh']);
    expect(actions.dialog()).toBeUndefined();
  });

  it('renames nothing for an empty or the same name, and saves over a conflict once', async () => {
    let tries = 0;
    const { actions, toasts } = fixture({
      document: shop,
      update: async () => {
        if (tries++ === 0) throw new ApiFailure('changed', 'conflict', 409);
        return {};
      },
    });
    actions.rename(row({ connection: 'c1', type: 'connection' }));
    const dialog = actions.dialog()!;
    expect(await dialog.run({ first: ' ', second: '' } as never)).toBeUndefined();
    expect(await dialog.run({ first: 'Shop', second: '' } as never)).toBeUndefined();
    await dialog.run({ first: 'Store', second: '' } as never);
    expect(tries).toBe(2);
    expect(toasts).toEqual([]);
  });

  it('gives up when the connection is gone after a conflict, and on any other failure', async () => {
    const conflict = fixture({
      document: shop,
      update: async () => {
        throw new ApiFailure('changed', 'conflict', 409);
      },
    });
    conflict.actions.rename(row({ connection: 'c1', type: 'connection' }));
    const run = conflict.actions.dialog()!.run;
    conflict.documents.set([]);
    await expect(run({ first: 'Other', second: '' } as never)).rejects.toThrow('changed');
    const failing = fixture({
      document: shop,
      update: async () => {
        throw new Error('disk full');
      },
    });
    failing.actions.moveTo(row({ connection: 'c1', type: 'connection' }));
    await expect(
      failing.actions.dialog()!.run({ first: 'A', second: '' } as never),
    ).rejects.toThrow('disk full');
  });
});
