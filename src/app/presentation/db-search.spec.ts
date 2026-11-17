import { describe, expect, it } from 'vitest';
import { DbPanelTest, dbConnection, startDbPanel } from '../testing/db-panel';

const hit = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  kind,
  name,
  schema: 'shop',
  path: ['shop', 'tables', name],
  ...extra,
});

/** A fake `db.search`: objects by mode, tables to list, and the data of each table. */
function search(payload: Record<string, unknown>) {
  if (payload['mode'] === 'metadata') {
    if (String(payload['statement']).startsWith('tables-'))
      return { objects: [hit('table', 'orders'), hit('view', 'totals', { schema: undefined })] };
    if (payload['text'] === 'boom') throw new Error('search failed');
    return {
      objects: [hit('table', 'orders'), hit('column', 'total', { table: 'orders', inCode: true })],
      more: true,
    };
  }
  const [table] = payload['tables'] as { name: string }[];
  return table.name === 'orders'
    ? {
        data: [
          {
            table: 'orders',
            path: ['shop', 'tables', 'orders'],
            matched: ['note'],
            columns: ['note'],
            rows: [['ann']],
          },
        ],
      }
    : { data: [] };
}

async function start(type = 'development') {
  const panel = await startDbPanel({
    connection: { driver: 'postgres', host: 'db', database: 'shop', type },
    responses: {
      'db.search': search,
      'db.cancel': () => ({}),
      'db.describe': () => ({ kind: 'table', name: 'orders', properties: [], sections: [] }),
      'db.ddl': () => ({ sql: '' }),
      'db.execute': () => ({ columns: [], rows: [], elapsedMs: 1 }),
    },
  });
  panel.api.documentsStore.push(
    dbConnection({ driver: 'postgres', host: 'other' }, 'c2', 'Other'),
    {
      id: 's1',
      workspace_id: 'local',
      kind: 'sql-script',
      name: 'Totals',
      revision: 1,
      updated_at: 0,
      value: { connectionId: 'c1', sql: 'SELECT 1;\nSELECT ann FROM orders' },
    },
    {
      id: 'h1',
      workspace_id: 'local',
      kind: 'sql-history',
      name: 'h1',
      revision: 1,
      updated_at: 0,
      value: { connectionId: 'c1', sql: 'DELETE FROM ann', startedAt: 1, durationMs: 1 },
    },
  );
  await panel.state.refresh();
  await panel.settle();
  return panel;
}

async function openSearch(panel: DbPanelTest) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true }));
  await panel.settle();
  return panel.dialog('Search the databases');
}

describe('the database search', () => {
  it('finds objects in the connections chosen, says which failed, and opens one', async () => {
    const panel = await start();
    const dialog = await openSearch(panel);
    await panel.click('Search', dialog);
    expect(panel.calls('db.search')).toEqual([]);
    await panel.fill('Name, with * or % as wildcards', 'ord', dialog);
    await panel.fill('Only in the schemas (comma separated)', 'shop, , archive', dialog);
    const other = [...dialog.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Other'),
    )!;
    other.querySelector('input')!.click();
    const views = [...dialog.querySelectorAll('label')].find((label) =>
      /^Views?$/.test(label.textContent?.trim() ?? ''),
    );
    views?.querySelector('input')!.click();
    await panel.settle();
    await panel.click(/^Search$/, dialog);
    const [asked] = panel.calls('db.search');
    expect(asked).toMatchObject({ mode: 'metadata', text: 'ord', schemas: ['shop', 'archive'] });
    expect(asked['kinds']).not.toContain('view');
    const found = panel.root().querySelector<HTMLElement>('[aria-label="Objects found"]')!;
    expect(found.textContent).toContain('shop.orders');
    expect(found.textContent).toContain('shop.orders.total');
    expect(found.textContent).toContain('in its code');
    expect(panel.calls('db.search')).toHaveLength(2);

    await panel.click('shop.orders.total', found);
    expect(panel.section().searching()).toBe(false);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'object', title: 'total' });
  });

  it('shows a failure of one connection, and remembers what was searched', async () => {
    const panel = await start();
    const dialog = await openSearch(panel);
    await panel.fill('Name, with * or % as wildcards', 'boom', dialog);
    await panel.click(/^Search$/, dialog);
    expect(dialog.textContent).toContain('search failed');
    await panel.click('Close', dialog);
    expect(panel.section().searching()).toBe(false);
    const again = await openSearch(panel);
    expect(again.querySelector('#db-search-recent option[value="boom"]')).not.toBeNull();
  });

  it('lists tables, searches their data one at a time and opens what it found', async () => {
    const panel = await start();
    const dialog = await openSearch(panel);
    await panel.click(/^Data$/, dialog);
    await panel.fill('Text to find', 'ann', dialog);
    await panel.fill('Tables named like', '', dialog);
    await panel.click('List the tables', dialog);
    expect(panel.calls('db.search')[0]).toMatchObject({ text: '%', kinds: ['table', 'view'] });
    expect(dialog.textContent).toContain('totals');
    for (const label of ['Match the case', 'Whole words', 'Number columns'])
      (panel.control(label, dialog) as HTMLInputElement).click();
    await panel.settle();
    await panel.click(/^Search$/, dialog);
    const data = panel.calls('db.search').filter((payload) => payload['mode'] === 'data');
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      caseSensitive: true,
      wholeWord: true,
      columns: ['text'],
      tables: [{ schema: 'shop', name: 'orders', path: ['shop', 'tables', 'orders'] }],
    });
    expect(data[1]['tables']).toEqual([{ name: 'totals', path: ['shop', 'tables', 'totals'] }]);
    const found = panel.root().querySelector<HTMLElement>('[aria-label="Data found"]')!;
    expect(found.textContent).toContain('orders');
    await panel.click('orders', found);
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'object', part: 'data' });
    expect(panel.section().tabs.active()?.query?.where).toContain('ann');
  });

  it('asks before reading whole tables on production, and searches only the tables chosen', async () => {
    const panel = await start('production');
    const dialog = await openSearch(panel);
    await panel.click(/^Data$/, dialog);
    await panel.fill('Text to find', 'ann', dialog);
    await panel.click('List the tables', dialog);
    const tables = dialog.querySelectorAll<HTMLInputElement>('.db-search-tables input');
    tables[1].click();
    await panel.settle();
    const search = panel.buttons(/^Search$/, dialog)[0];
    search.click();
    await panel.settle();
    expect(panel.calls('db.search').filter((payload) => payload['mode'] === 'data')).toEqual([]);
    (panel.control('This connection is for production', dialog) as HTMLInputElement).click();
    await panel.settle();
    await panel.click(/^Search$/, dialog);
    const data = panel.calls('db.search').filter((payload) => payload['mode'] === 'data');
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ confirm: true });
  });

  it('finds the text in saved scripts and the history, and opens a line', async () => {
    const panel = await start();
    const dialog = await openSearch(panel);
    await panel.click(/^Scripts$/, dialog);
    await panel.fill('Text to find', 'ann', dialog);
    await panel.click(/^Search$/, dialog);
    const found = panel.root().querySelector<HTMLElement>('[aria-label="Lines found"]')!;
    expect(found.textContent).toContain('Totals');
    expect(found.textContent).toContain('History');
    await panel.click('History', found);
    expect(panel.section().tabs.draft(panel.section().tabs.activeId()).text).toBe(
      'DELETE FROM ann',
    );
    const again = await openSearch(panel);
    expect(again.querySelector('#db-search-recent option[value="ann"]')).not.toBeNull();
    await panel.click(/^Scripts$/, again);
    await panel.fill('Text to find', 'SELECT 1', again);
    await panel.click(/^Search$/, again);
    await panel.click(
      'Totals',
      panel.root().querySelector<HTMLElement>('[aria-label="Lines found"]')!,
    );
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'sql' });
  });
});
