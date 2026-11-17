import { describe, expect, it } from 'vitest';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';
import { typeCode } from '../testing/controls';

const keyed = [
  {
    name: 'id',
    typeName: 'int4',
    kind: 'integer',
    key: true,
    nullable: false,
    origin: { table: 'orders', column: 'id' },
  },
  {
    name: 'note',
    typeName: 'text',
    kind: 'text',
    nullable: true,
    origin: { table: 'orders', column: 'note' },
  },
];
const loose = [
  { name: 'id', typeName: 'int4', kind: 'integer', origin: { table: 'log', column: 'id' } },
  { name: 'note', typeName: 'text', kind: 'text', origin: { table: 'log', column: 'note' } },
];

function split(payload: Record<string, unknown>) {
  const text = String(payload['script']).trim();
  return {
    statements: text
      ? [
          {
            text,
            start: 0,
            end: text.length,
            line: 1,
            classification: {
              kind: 'read',
              missingWhere: false,
              truncate: false,
              drop: [],
              drops: false,
            },
          },
        ]
      : [],
    current: text ? 0 : null,
  };
}

async function start(type = 'development') {
  return startDbPanel({
    connection: { driver: 'postgres', host: 'db', database: 'shop', type },
    tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    responses: {
      'db.split': split,
      'db.execute': (payload: Record<string, unknown>) => ({
        columns: /log/.test(String(payload['sql'])) ? loose : keyed,
        rows: [
          [1, 'a'],
          [2, null],
        ],
        cursor: 'k',
        elapsedMs: 3,
      }),
      'db.fetch': () => ({ rows: [[3, 'c']], cursor: null }),
      'db.rows.write': () => ({ affected: 1, statements: [] }),
    },
  });
}
async function run(panel: DbPanelTest, sql: string) {
  typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, sql);
  await panel.settle();
  await panel.click(/^▶ Run$/);
}
const toolbar = (panel: DbPanelTest) =>
  panel.root().querySelector<HTMLElement>('.db-result-toolbar[role="toolbar"]')!;
const edits = (panel: DbPanelTest) => panel.root().querySelector<HTMLElement>('app-db-row-edits')!;
const resultTabs = (panel: DbPanelTest) =>
  [...panel.root().querySelectorAll('[aria-label="Results"] [role="tab"]')].map((tab) =>
    tab.textContent?.trim(),
  );

describe('the results of a SQL tab', () => {
  it('pins, detaches and closes result tabs, and moves between them with the arrows', async () => {
    const panel = await start();
    await run(panel, 'select * from orders');
    await panel.click('↗ New tab').catch(() => undefined);
    await run(panel, 'select * from orders where id = 1');
    await panel.click(/^Pin$/, toolbar(panel));
    expect(panel.buttons(/^Unpin$/, toolbar(panel))).toHaveLength(1);
    await panel.click(/^Detach$/, toolbar(panel));
    expect(panel.root().querySelector('[role="dialog"]')).not.toBeNull();
    await panel.click('Attach again');
    const tabs = panel.root().querySelectorAll<HTMLElement>('[aria-label="Results"] [role="tab"]');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await panel.settle();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await panel.settle();
    await panel.click(/^Close the unpinned$/, toolbar(panel));
    expect(resultTabs(panel).filter((title) => !title?.startsWith('Messages'))).toHaveLength(1);
    await panel.click(/^Close the others$/, toolbar(panel));
    await panel.click(/^Close$/, toolbar(panel));
    expect(resultTabs(panel).filter((title) => !title?.startsWith('Messages'))).toEqual([]);
    await panel.click('Clear');
  });

  it('shows the metadata, the figures and the summary of a result', async () => {
    const panel = await start();
    await run(panel, 'select * from orders');
    const views = panel.root().querySelector<HTMLElement>('[aria-label="Result views"]')!;
    await panel.click('Metadata', views);
    expect(panel.text()).toContain('orders.note');
    await panel.click('Info', views);
    expect(panel.text()).toContain('select * from orders');
    await panel.click('Summary', views);
    expect(panel.text()).toContain('Distinct');
    await panel.click('Export…', toolbar(panel));
    expect(panel.section().transferRequest()).toMatchObject({
      kind: 'export',
      sql: 'select * from orders',
    });
    panel.section().transferRequest.set(undefined);
    await panel.click('Repeat', toolbar(panel));
    expect(panel.buttons('Stop repeating', toolbar(panel))).toHaveLength(1);
    await panel.click('Stop repeating', toolbar(panel));
  });

  it('edits rows in the grid, shows the script, undoes and saves them', async () => {
    const panel = await start();
    await run(panel, 'select * from orders');
    await panel.click('Edit in the grid');
    await panel.click('Add row');
    await panel.click('View script');
    expect(panel.dialog('The script of the save').textContent).toContain(
      'INSERT INTO orders DEFAULT VALUES;',
    );
    await panel.click('Close', panel.dialog('The script of the save'));
    await panel.click(/^Undo/);
    await panel.click('Add row');
    await panel.click('Discard');
    await panel.click('Add row');
    (panel.control('Optimistic locking') as HTMLInputElement).click();
    await panel.settle();
    await panel.click(/^Save/, edits(panel));
    expect(panel.calls('db.rows.write')[0]).toMatchObject({ table: 'orders', optimistic: true });
  });

  it('asks before saving on production', async () => {
    const panel = await start('production');
    await run(panel, 'select * from orders');
    await panel.click('Edit in the grid');
    await panel.click('Add row');
    await panel.click(/^Save/, edits(panel));
    const question = panel.dialog();
    await panel.click('Cancel', question);
    expect(panel.calls('db.rows.write')).toEqual([]);
    await panel.click(/^Save/, edits(panel));
    await panel.click(/^Save/, panel.dialog());
    expect(panel.calls('db.rows.write')[0]).toMatchObject({ confirm: true });
  });

  it('chooses a virtual key and adds virtual columns in the Data tab of a table', async () => {
    const panel = await startDbPanel({
      tabs: [{ id: 'o1', kind: 'object', title: 'log', path: ['public', 'tables', 'log'] }],
      responses: {
        'db.describe': () => ({ kind: 'table', name: 'log', properties: [], sections: [] }),
        'db.ddl': () => ({ sql: '' }),
        'db.execute': () => ({ columns: loose, rows: [[1, 'a']], elapsedMs: 1 }),
      },
    });
    for (let i = 0; i < 10 && !panel.text().includes('Choose a key…'); i++) {
      await new Promise((done) => setTimeout(done, 20));
      await panel.settle();
    }
    expect(panel.text()).toContain('Choose a key…');
    await panel.click('Choose a key…');
    const dialog = panel.dialog('Choose a virtual key');
    (panel.control('id', dialog) as HTMLInputElement).click();
    await panel.settle();
    await panel.click('Use as the key', dialog);
    const value = () =>
      panel.api.documentsStore.find((document) => document.id === 'c1')!.value as {
        virtualKeys?: Record<string, string[]>;
        virtualColumns?: Record<string, unknown[]>;
      };
    expect(value().virtualKeys).toEqual({ log: ['id'] });
    await panel.settle();
    await panel.click('Virtual columns…');
    const columns = panel.dialog('Virtual columns');
    await panel.fill('Name', 'twice', columns);
    await panel.fill('Expression', '((', columns);
    await panel.click(/^Add$/, columns);
    expect(columns.textContent).toMatch(/expression|valid/i);
    await panel.fill('Expression', 'id * 2', columns);
    await panel.click(/^Add$/, columns);
    expect(value().virtualColumns).toEqual({ log: [{ name: 'twice', expression: 'id * 2' }] });
    await panel.click('Remove', panel.dialog('Virtual columns'));
    expect(value().virtualColumns).toEqual({});
  });
  it('moves the detached window by its title, and edits from the grid menu', async () => {
    const panel = await start();
    await run(panel, 'select * from orders');
    await panel.click(/^Detach$/, toolbar(panel));
    const head = panel.root().querySelector<HTMLElement>('.db-floating-head')!;
    const pointer = (type: string, x: number, target: Element = head) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: x });
      target.dispatchEvent(event);
    };
    pointer('pointermove', 50);
    pointer('pointerdown', 10, head.querySelector('button')!);
    pointer('pointerdown', 10);
    pointer('pointermove', 60);
    pointer('pointerup', 60);
    pointer('pointermove', 300);
    await panel.settle();
    const floating = panel.root().querySelector<HTMLElement>('.db-floating')!;
    expect(floating.style.left).toBe('146px');
    await panel.click('Attach again');
    await panel.click('Edit in the grid');
    const grid = panel.root().querySelector<HTMLElement>('[role="grid"]')!;
    grid
      .querySelector<HTMLElement>('[data-column="1"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    grid
      .querySelector<HTMLElement>('[data-column="1"]')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await panel.settle();
    await panel.click('Set to NULL', panel.root().querySelector<HTMLElement>('[role="menu"]')!);
    await panel.click('View script');
    expect(panel.dialog('The script of the save').textContent).toContain('NULL');
    await panel.click('Close', panel.dialog('The script of the save'));
    await panel.click('Edit in the grid');
    expect(panel.root().querySelector('app-db-row-edits')).toBeNull();
  });
});
