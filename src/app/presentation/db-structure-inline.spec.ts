import { describe, expect, it } from 'vitest';
import { driverHello, startDbPanel } from '../testing/db-panel';
import { change, orders, plan, start, tree } from '../testing/db-structure';

describe('the structure editor in the Columns view', () => {
  it('edits the columns in place in the Columns view, saves and reverts', async () => {
    const panel = await startDbPanel({
      tree,
      hello: driverHello({ methods: ['ddl.model', 'ddl.plan'] }),
      tabs: [{ id: 'o1', kind: 'object', title: 'orders', path: ['tables', 'orders'] }],
      responses: {
        'db.ddl.model': () => ({ table: orders, types: ['integer', 'text'] }),
        'db.ddl.plan': plan,
        'db.execute': () => ({ columns: [], rows: [], elapsedMs: 1 }),
        'db.describe': () => ({
          kind: 'table',
          name: 'orders',
          properties: [],
          sections: [{ id: 'columns', title: 'Columns', columns: ['Name'], rows: [] }],
        }),
        'db.ddl': () => ({ sql: '' }),
      },
    });
    const views = panel.root().querySelector<HTMLElement>('[aria-label="Object views"]')!;
    await panel.click('Columns', views);
    const toolbar = panel
      .root()
      .querySelector<HTMLElement>('[role="toolbar"][aria-label="Columns"]')!;
    const save = panel.buttons('Save', toolbar)[0];
    expect(save.disabled).toBe(true);
    const type = panel.control('Type of note') as HTMLInputElement;
    await change(panel, type, 'varchar(5)');
    expect(toolbar.textContent).toContain('Changes not saved yet');
    expect(type.closest('td')?.classList).toContain('db-structure-changed');
    await panel.click('Revert', toolbar);
    expect((panel.control('Type of note') as HTMLInputElement).value).toBe('text');
    await change(panel, panel.control('Type of note') as HTMLInputElement, 'varchar(5)');
    await panel.click('Save', toolbar);
    const review = panel.dialog('The statements that make the change');
    await panel.click('Cancel', review);
    expect(panel.root().textContent).not.toContain('The column note is dropped');
    await panel.click('Save', toolbar);
    await panel.click('Run', panel.dialog('The statements that make the change'));
    const changes = panel
      .calls('db.execute')
      .filter(
        (payload) => payload['statement'] !== undefined && !/^SELECT/.test(String(payload['sql'])),
      );
    expect(changes.map((payload) => payload['sql'])).toEqual([
      'ALTER TABLE orders ADD x int',
      "COMMENT ON TABLE orders IS 'c'",
    ]);
    expect(changes[0]).toMatchObject({ confirmName: 'orders' });
    expect(panel.calls('db.ddl.model').length).toBeGreaterThanOrEqual(2);
    await change(panel, panel.control('Type of note') as HTMLInputElement, 'varchar(9)');
    await panel.click('Save', toolbar);
    await panel.click('Open in a script', panel.dialog('The statements that make the change'));
    expect(panel.section().tabs.active()?.kind).toBe('sql');
  });

  it('offers no structure entries when the driver does not edit structure', async () => {
    const panel = await start({ methods: [] });
    await panel.open('Shop', 'Tables');
    expect(await panel.menuEntries('Tables')).not.toContain('New table…');
    expect(await panel.menuEntries('orders')).not.toContain('Edit structure…');
  });
});
