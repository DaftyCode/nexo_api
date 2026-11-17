import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { emptyDiagram, layoutKey } from '../../domain/db/erd-document';
import { WorkspaceDocument } from '../../domain/models';
import { databaseCases } from '../../testing/database-cases';
import {
  addTables,
  connectionTables,
  diagramValue,
  loadDiagram,
  saveDiagram,
} from './diagram-load';
import { SectionDiagrams } from './diagrams';
import type { DbSection } from './section';
import { DbTabsStore } from './tabs-store';

const model = (name: string, schema = 'public', keys: unknown[] = []) => ({
  table: {
    schema,
    name,
    columns: [{ name: 'id', typeName: 'int', nullable: false }],
    primaryKey: { columns: ['id'] },
    foreignKeys: keys,
  },
});
const tree: Record<string, unknown[]> = {
  '': [{ kind: 'folder', name: 'schemas', label: 'schemas', actions: [] }],
  schemas: [{ kind: 'schema', name: 'public', label: 'public', actions: [] }],
  'schemas/public': [{ kind: 'folder', name: 'tables', label: 'tables', actions: [] }],
  'schemas/public/tables': [
    { kind: 'table', name: 'orders', label: 'orders', actions: [] },
    { kind: 'table', name: 'users', label: 'users', actions: [] },
  ],
};
const orders = ['schemas', 'public', 'tables', 'orders'];

function fakeSection(
  options: { methods?: string[]; online?: boolean; documents?: unknown[] } = {},
) {
  const fake = databaseCases({
    'db.tree': (payload: Record<string, unknown>) => ({
      nodes: tree[(payload['path'] as string[]).join('/')] ?? [],
    }),
    'db.ddl.model': (payload: Record<string, unknown>) => {
      const name = (payload['path'] as string[]).at(-1)!;
      if (name === 'missing') throw new Error('gone');
      return model(
        name,
        'public',
        name === 'orders'
          ? [{ columns: ['id'], referencedTable: 'users', referencedColumns: ['id'] }]
          : [],
      );
    },
    'db.describe': () => ({ sections: [] }),
  });
  const documents = signal<WorkspaceDocument[]>((options.documents ?? []) as WorkspaceDocument[]);
  const connected = signal<Record<string, string>>({ c1: options.online ? 'connected' : 'idle' });
  let ids = 0;
  const tabs = new DbTabsStore(() => `t${++ids}`);
  const holder = {
    tabs,
    cases: async () => fake.cases,
    connection: (id: string) => (id === 'c1' ? { id: 'c1', name: 'Shop' } : undefined),
    tree: {
      status: connected,
      connect: async () => {
        if (options.online === false) return false;
        connected.set({ c1: 'connected' });
        return true;
      },
    },
    drivers: { capabilities: () => ({ methods: options.methods ?? ['ddl.model'] }) },
    state: {
      workspaceId: () => 'w',
      documents,
      databaseSession: () => ({
        diagrams: { [layoutKey('c1', ['schemas'])]: { positions: {}, notation: 'uml' } },
      }),
      cases: { files: { id: () => `d${++ids}` } },
      refresh: async () => documents.set([...documents(), ...(fake.saved as WorkspaceDocument[])]),
      confirm: () => true,
    },
  } as unknown as DbSection & { diagrams: SectionDiagrams };
  holder.diagrams = new SectionDiagrams(holder);
  return { section: holder, fake, tabs };
}

describe('the diagrams of the section', () => {
  it('opens the diagram of a schema in a tab, and of a table in its «Diagram» view', () => {
    const { section, tabs } = fakeSection();
    const diagrams = section.diagrams;
    diagrams.view({
      key: 'k',
      type: 'node',
      level: 1,
      label: 'x',
      expandable: false,
      expanded: false,
    });
    expect(tabs.tabs()).toEqual([]);
    const row = { key: 'k', type: 'node' as const, level: 2, expandable: true, expanded: false };
    diagrams.view({ ...row, label: 'public', connection: 'c1', path: ['schemas', 'public'] });
    expect(tabs.active()).toMatchObject({ kind: 'diagram', path: ['schemas', 'public'] });
    diagrams.view({
      ...row,
      label: 'orders',
      connection: 'c1',
      path: orders,
      node: {
        kind: 'table',
        name: 'orders',
        label: 'orders',
        hasChildren: false,
        actions: ['open'],
      },
    });
    expect(tabs.active()).toMatchObject({ kind: 'object', part: 'diagram', path: orders });
  });

  it('keeps one draft per open tab, its layout restored from the session', () => {
    const { section, tabs } = fakeSection();
    const diagrams = section.diagrams;
    const tab = tabs.open({ kind: 'diagram', connection: 'c1', title: 's', path: ['schemas'] });
    const draft = diagrams.draft(tab);
    expect(draft.notation()).toBe('uml');
    expect(diagrams.draft(tab)).toBe(draft);
    draft.setDetail('none');
    expect(diagrams.layout('c1', ['schemas'])?.detail).toBe('none');
    expect(diagrams.unsaved(tab.id)).toBe(false);
    tabs.close(tab.id);
    const reopened = tabs.open({ kind: 'diagram', connection: 'c1', title: 's', path: ['x'] });
    expect(diagrams.draft(reopened)).not.toBe(draft);
  });

  it('reads the tables under a node, or a table and its neighbours, connecting first', async () => {
    const { section, tabs, fake } = fakeSection();
    const node = tabs.open({ kind: 'diagram', connection: 'c1', title: 's', path: ['schemas'] });
    const draft = section.diagrams.draft(node);
    await loadDiagram(section, draft);
    expect(draft.tables().map((table) => table.entity.key)).toEqual([
      'public.orders',
      'public.users',
    ]);
    expect(draft.loaded()).toBe(true);
    expect(draft.progress()).toBeUndefined();
    expect(draft.model().relations).toHaveLength(1);

    const object = tabs.open({ kind: 'object', connection: 'c1', title: 'orders', path: orders });
    const near = section.diagrams.draft(object);
    await loadDiagram(section, near);
    expect(near.tables().map((table) => table.entity.key)).toEqual([
      'public.orders',
      'public.users',
    ]);
    expect(fake.named('db.describe').length).toBeGreaterThan(0);
    expect(await connectionTables(section, 'c1')).toHaveLength(2);
  });

  it('says why a diagram cannot be read', async () => {
    const offline = fakeSection({ online: false });
    const tab = offline.tabs.open({ kind: 'diagram', connection: 'c1', title: 's', path: [] });
    await expect(loadDiagram(offline.section, offline.section.diagrams.draft(tab))).rejects.toThrow(
      'db.object.offline',
    );
    const gone = offline.tabs.open({ kind: 'diagram', connection: 'c9', title: 's', path: [] });
    await expect(
      loadDiagram(offline.section, offline.section.diagrams.draft(gone)),
    ).rejects.toThrow('db.diagram.noConnection');
  });

  it('creates, fills, saves, reopens and deletes a diagram of the person', async () => {
    const { section, tabs, fake } = fakeSection({ online: true, methods: [] });
    const diagrams = section.diagrams;
    await diagrams.create('c1');
    const document = diagrams.saved()[0];
    expect(document).toMatchObject({ kind: 'db-diagram', name: 'Diagram' });
    expect(tabs.active()).toMatchObject({ kind: 'diagram', diagram: document.id });
    const draft = diagrams.draft(tabs.active()!);
    await loadDiagram(section, draft);
    expect(draft.tables()).toEqual([]);

    await addTables(section, draft, [{ path: orders, name: 'orders', schema: 'public' }], {
      x: 100,
      y: 50,
    });
    expect(draft.positions()).toEqual({ 'public.orders': { x: 100, y: 50 } });
    expect(diagrams.unsaved(tabs.active()!.id)).toBe(true);
    draft.select('public.orders');
    draft.paint('danger');
    draft.removeSelected();
    await addTables(section, draft, [{ path: orders, name: 'orders', schema: 'public' }], {
      x: 0,
      y: 0,
    });
    expect(draft.hidden()).toEqual([]);
    draft.hidden.set(['public.orders']);
    draft.addNote('n1', { x: 1, y: 2 });
    draft.name.set('  ');
    expect(diagramValue(draft).entities[0]).toMatchObject({ hidden: true, color: 'danger' });

    expect(await saveDiagram(section, draft)).toMatchObject({ title: 'Diagram saved' });
    expect(fake.saved.at(-1)).toMatchObject({ name: 'Diagram', revision: document.revision });
    expect(draft.dirty()).toBe(false);

    const value = { ...emptyDiagram('c1'), ...diagramValue(draft), notation: 'crowsfoot' };
    const reread = section.diagrams.draft(
      tabs.open({ kind: 'diagram', connection: 'c1', title: 'x', diagram: 'other' }),
    );
    section.state.documents.set([{ ...document, id: 'other', name: 'Other', value }]);
    await loadDiagram(section, reread);
    expect(reread).toMatchObject({ source: { id: 'other' } });
    expect(reread.name()).toBe('Other');
    expect(reread.notation()).toBe('crowsfoot');
    expect(reread.hidden()).toEqual(['public.orders']);
    expect(reread.colors()).toEqual({ 'public.orders': 'danger' });
    expect(reread.notes()).toHaveLength(1);

    diagrams.openId('nothing');
    diagrams.openId('other');
    expect(tabs.active()?.diagram).toBe('other');
    expect(await diagrams.remove('nothing')).toBeUndefined();
    expect(await diagrams.remove('other')).toMatchObject({ title: 'Diagram deleted' });
    expect(tabs.tabs().some((tab) => tab.diagram === 'other')).toBe(false);
    expect(
      await saveDiagram(
        section,
        diagrams.draft(tabs.open({ kind: 'diagram', connection: 'c1', title: 'n', path: [] })),
      ),
    ).toBeUndefined();
  });
});
