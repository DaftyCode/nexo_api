import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbPanelTest, driverHello, node, startDbPanel } from '../testing/db-panel';

const tree = {
  '': [node('database', 'shop')],
  shop: [node('folder', 'schemas', { label: 'Schemas' })],
  'shop/schemas': [node('schema', 'public')],
  'shop/schemas/public': [
    node('folder', 'tables', { label: 'Tables' }),
    node('folder', 'views', { label: 'Views' }),
    node('folder', 'materialized-views', { label: 'Materialized views' }),
  ],
  'shop/schemas/public/tables': [node('table', 'Orders')],
  'shop/schemas/public/materialized-views': [node('view', 'totals')],
};
const columns = [
  { name: 'id', typeName: 'int4', kind: 'integer', key: true },
  { name: 'note', typeName: 'text', kind: 'text' },
];

async function start() {
  const written: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const panel = await startDbPanel({
    tree,
    hello: driverHello({}),
    responses: {
      'db.execute': (payload: Record<string, unknown>) =>
        /WHERE 1 = 0/.test(String(payload['sql']))
          ? { columns, rows: [], elapsedMs: 1 }
          : { columns: [], rows: [], elapsedMs: 1 },
      'db.ddl': () => ({ sql: 'CREATE TABLE "Orders" (id int)' }),
      'db.describe': () => ({ kind: 'table', name: 'Orders', properties: [], sections: [] }),
      'db.fetch': () => ({ rows: [], cursor: null }),
    },
  });
  return { panel, written };
}

async function openOrders(panel: DbPanelTest) {
  await panel.open('Shop', 'shop', 'Schemas', 'public', 'Tables');
}
const sqlText = (panel: DbPanelTest) =>
  panel.section().tabs.draft(panel.section().tabs.activeId()).text;
async function answer(panel: DbPanelTest, values: string[], confirm: string | RegExp) {
  const dialog = panel.dialog();
  const inputs = [...dialog.querySelectorAll<HTMLInputElement>('input')];
  values.forEach((value, at) => {
    inputs[at].value = value;
    inputs[at].dispatchEvent(new Event('input'));
  });
  await panel.settle();
  await panel.click(confirm, dialog);
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('the actions of the navigator', () => {
  it('renames, duplicates, moves, filters and bookmarks a connection', async () => {
    const { panel } = await start();
    await panel.menu('Shop', 'Rename');
    await answer(panel, ['Store'], 'Rename');
    expect(panel.api.documentsStore.find((document) => document.id === 'c1')?.name).toBe('Store');

    await panel.menu('Store', 'Duplicate');
    expect(panel.api.documentsStore.map((document) => document.name)).toContain('Store (copy)');

    await panel.menu('Store (copy)', 'Move to folder');
    await answer(panel, ['Archive'], 'Move');
    expect(panel.rows()).toContain('Archive');

    await panel.open('Store');
    await panel.menu('shop', 'Filter objects');
    await answer(panel, ['sch*', 'tmp'], 'Apply');
    const value = panel.api.documentsStore.find((document) => document.id === 'c1')!.value as {
      filters?: unknown[];
    };
    expect(value.filters).toEqual([{ path: ['shop'], include: 'sch*', exclude: 'tmp' }]);

    await panel.menu('shop', /^Bookmark$/);
    expect(
      panel
        .section()
        .bookmarks()
        .map((mark) => mark.label),
    ).toEqual(['shop']);
    await panel.menu('shop', 'Remove bookmark');
    expect(panel.section().bookmarks()).toEqual([]);
  });

  it('connects, refreshes, disconnects and opens consoles and scripts on a connection', async () => {
    const { panel } = await start();
    expect(await panel.menuEntries('Shop')).toContain('Connect');
    await panel.menu('Shop', /^Connect$/);
    expect(panel.calls('db.connect')).toHaveLength(1);
    const asked = panel.calls('db.tree').length;
    await panel.menu('Shop', /^Refresh/);
    expect(panel.calls('db.tree').length).toBeGreaterThan(asked);
    await panel.menu('Shop', 'Reconnect');
    expect(panel.calls('db.connect')).toHaveLength(2);
    await panel.menu('Shop', 'Disconnect');
    expect(panel.calls('db.disconnect').length).toBeGreaterThan(0);
    await panel.menu('Shop', 'SQL console');
    expect(panel.section().tabs.active()?.kind).toBe('console');
    await panel.menu('Shop', /^New SQL script/);
    expect(panel.section().tabs.active()?.kind).toBe('sql');
    await panel.menu('Shop', 'Edit connection');
    expect(panel.text()).toContain('Connection name');
  });

  it('generates SQL of a table, copies its name and DDL, and opens it', async () => {
    const { panel, written } = await start();
    await openOrders(panel);
    await panel.menu('Orders', 'Generate SELECT');
    expect(panel.calls('db.execute').at(-1)?.['sql']).toBe(
      'SELECT * FROM public."Orders" WHERE 1 = 0',
    );
    expect(sqlText(panel)).toBe('SELECT id, note\nFROM public."Orders";');
    for (const kind of ['INSERT', 'UPDATE', 'DELETE', 'MERGE']) {
      await panel.menu('Orders', `Generate ${kind}`);
      expect(sqlText(panel)).toContain(kind === 'MERGE' ? 'MERGE INTO' : kind);
    }
    await panel.menu('Orders', 'Copy name');
    await panel.menu('Orders', 'Copy DDL');
    expect(written).toEqual(['"Orders"', 'CREATE TABLE "Orders" (id int)']);

    await panel.menu('Orders', 'View data');
    expect(sqlText(panel)).toBe('SELECT * FROM public."Orders"');
    await panel.menu('Orders', /^Open$/);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'object', title: 'Orders' });
    for (const entry of ['Export data…', 'Import data…', 'Copy to another connection…']) {
      await panel.menu('Orders', entry);
      expect(panel.section().transferRequest()).toBeDefined();
      panel.section().transferRequest.set(undefined);
      await panel.settle();
    }
  });

  it('starts views from a template and refreshes a materialized view', async () => {
    const { panel } = await start();
    await panel.open('Shop', 'shop', 'Schemas', 'public', 'Materialized views');
    await panel.menu('Views', 'New in Views… (as SQL)');
    expect(sqlText(panel)).toMatch(/^CREATE VIEW public\.new_view AS/);
    await panel.menu('Materialized views', 'New in Materialized views… (as SQL)');
    expect(sqlText(panel)).toMatch(/^CREATE MATERIALIZED VIEW public\.new_view/);
    await panel.menu('totals', 'Refresh materialized view');
    expect(sqlText(panel)).toBe('REFRESH MATERIALIZED VIEW public.totals');
    expect(await panel.menuEntries('Tables')).toContain('Filter objects');
  });

  it('opens and deletes a saved script from the navigator', async () => {
    const { panel } = await start();
    panel.api.documentsStore.push({
      id: 's1',
      workspace_id: 'local',
      kind: 'sql-script',
      name: 'Totals',
      revision: 1,
      updated_at: 0,
      value: { connectionId: 'c1', sql: 'SELECT 2' },
    });
    await panel.state.refresh();
    await panel.settle();
    await panel.menu('Totals', /^Open$/);
    expect(sqlText(panel)).toBe('SELECT 2');
    await panel.menu('Totals', 'Delete script');
    expect(panel.api.documentsStore.some((document) => document.id === 's1')).toBe(false);
  });

  it('deletes a connection once its name is typed, with its tabs and bookmarks', async () => {
    const { panel } = await start();
    await panel.menu('Shop', /^Bookmark$/);
    await panel.menu('Shop', 'SQL console');
    await panel.menu('Shop', /^Delete/);
    const dialog = panel.dialog();
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>('input')];
    const typed = inputs.at(-1)!;
    typed.value = 'Shop';
    typed.dispatchEvent(new Event('input'));
    await panel.settle();
    await panel.click('Delete', dialog);
    expect(panel.api.documentsStore.some((document) => document.kind === 'connection')).toBe(false);
    expect(panel.section().tabs.tabs()).toEqual([]);
    expect(panel.section().bookmarks()).toEqual([]);
  });

  it('saves a rename over a connection changed elsewhere', async () => {
    const { panel } = await start();
    const saved = panel.api.documentsStore.find((document) => document.id === 'c1')!;
    saved.revision = 9;
    await panel.menu('Shop', 'Rename');
    await answer(panel, ['Renamed'], 'Rename');
    expect(panel.api.documentsStore.find((document) => document.id === 'c1')?.name).toBe('Renamed');
    vi.restoreAllMocks();
  });
});
