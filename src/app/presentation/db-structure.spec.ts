import { describe, expect, it } from 'vitest';
import { change, input, start } from '../testing/db-structure';

describe('the structure editor', () => {
  it('creates a table from its columns, keys and indexes, read before it runs', async () => {
    const panel = await start();
    await panel.open('Shop', 'Tables');
    await panel.menu('Tables', 'New table…');
    const editor = panel.dialog('New table');
    await change(panel, input(panel, 'Table name'), 'items');
    await change(panel, input(panel, 'Comment'), 'The items');
    await panel.click('Add column', editor);
    await change(panel, input(panel, 'Name of column 2'), 'label');
    await change(panel, input(panel, 'Type of label'), 'text');
    await change(panel, input(panel, 'label is not null'), true);
    await change(panel, input(panel, 'Default of label'), "'none'");
    await change(panel, input(panel, 'Comment of label'), 'shown');
    await change(panel, input(panel, 'label is an identity'), true);
    await panel.click('Add column', editor);
    await panel.click('Remove the column column3', editor);

    await panel.click('Keys and indexes', editor);
    await change(panel, input(panel, 'Primary key (columns)'), 'id, label');
    await panel.click('Add unique', editor);
    await change(panel, input(panel, 'Unique columns'), 'label');
    await panel.click('Add check', editor);
    await change(panel, input(panel, 'Check'), 'id > 0');
    await panel.click('Add foreign key', editor);
    await change(panel, input(panel, 'Foreign key columns'), 'label');
    await change(panel, input(panel, 'Referenced table'), 'labels');
    await change(panel, input(panel, 'Referenced columns'), 'name');
    const [onDelete] = [...panel.dialog().querySelectorAll('select')];
    onDelete.value = 'CASCADE';
    onDelete.dispatchEvent(new Event('change'));
    await panel.settle();
    await panel.click('Add index', editor);
    await change(panel, input(panel, 'Index columns'), 'label DESC');
    await change(panel, input(panel, 'Method'), 'btree');
    await change(panel, input(panel, 'Condition'), 'id > 1');

    const table = panel.section().structureRequest();
    expect(table?.mode).toBe('create');
    await panel.click('Show the changes', editor);
    const asked = panel.calls('db.ddl.plan')[0]['target'] as Record<string, unknown>;
    expect(asked).toMatchObject({
      name: 'items',
      comment: 'The items',
      primaryKey: { columns: ['id', 'label'] },
      uniques: [{ columns: ['label'] }],
      checks: [{ expression: 'id > 0' }],
      foreignKeys: [
        {
          columns: ['label'],
          referencedTable: 'labels',
          referencedColumns: ['name'],
          onDelete: 'CASCADE',
        },
      ],
      indexes: [
        { name: 'items_index1', columns: ['label DESC'], method: 'btree', condition: 'id > 1' },
      ],
    });
    expect((asked['columns'] as unknown[])[1]).toMatchObject({
      name: 'label',
      typeName: 'text',
      nullable: false,
      default: "'none'",
      identity: true,
      comment: 'shown',
    });
    const review = panel.dialog('The statements that make the change');
    expect(review.textContent).toContain('They run in a transaction');
    await panel.click('Run', review);
    expect(panel.calls('db.execute').map((payload) => payload['sql'])).toEqual([
      'CREATE TABLE items (id integer)',
    ]);
    expect(
      panel
        .calls('db.transaction')
        .map((payload) => payload['action'])
        .filter((action) => action !== 'status'),
    ).toEqual(['begin', 'commit']);
    expect(panel.section().structureRequest()).toBeUndefined();
  });

  it('removes keys, checks, foreign keys and indexes before planning', async () => {
    const panel = await start();
    await panel.open('Shop', 'Tables');
    await panel.menu('Tables', 'New table…');
    const editor = panel.dialog('New table');
    await panel.click('Keys and indexes', editor);
    for (const add of ['Add unique', 'Add check', 'Add foreign key', 'Add index'])
      await panel.click(add, editor);
    const select = panel.dialog().querySelectorAll('select')[1];
    select.value = 'SET NULL';
    select.dispatchEvent(new Event('change'));
    await panel.settle();
    await change(panel, input(panel, 'Primary key (columns)'), ' ');
    for (let i = 0; i < 4; i++) await panel.click(/^×\s+Remove$/, editor);
    await panel.click('Show the changes', editor);
    expect(panel.calls('db.ddl.plan')[0]['target']).toMatchObject({
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    });
    expect(
      (panel.calls('db.ddl.plan')[0]['target'] as Record<string, unknown>)['primaryKey'],
    ).toBeUndefined();
  });

  it('edits a table, warns, and keeps the statements as a script instead', async () => {
    const panel = await start();
    await panel.open('Shop', 'Tables');
    await panel.menu('orders', 'Edit structure…');
    const editor = panel.dialog('Structure of orders');
    const show = panel.buttons('Show the changes', editor)[0];
    expect(show.disabled).toBe(true);
    await change(panel, input(panel, 'Type of note'), 'varchar(10)');
    expect(show.disabled).toBe(false);
    await panel.click('Show the changes', editor);
    const review = panel.dialog('The statements that make the change');
    expect(review.textContent).toContain('The column note is dropped with its values');
    expect(review.textContent).toContain('a failure half way leaves');
    await panel.click('Open in a script', review);
    expect(panel.section().tabs.active()?.kind).toBe('sql');
    expect(panel.section().tabs.draft(panel.section().tabs.activeId()).text).toContain(
      'ALTER TABLE orders ADD x int',
    );
  });

  it('drops a table, with cascade, only with its name typed', async () => {
    const panel = await start();
    await panel.open('Shop', 'Tables');
    await panel.menu('orders', 'Drop table…');
    const editor = panel.dialog('Drop orders');
    const cascade = editor.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await change(panel, cascade, true);
    await panel.click('Show the DROP', editor);
    expect(panel.calls('db.ddl.plan')[0]).toMatchObject({ cascade: true });
    const review = panel.dialog('The statements that make the change');
    const run = panel.buttons('Run', review)[0];
    expect(run.disabled).toBe(true);
    await change(
      panel,
      panel.control('Type orders to confirm', review) as HTMLInputElement,
      'orders',
    );
    expect(run.disabled).toBe(false);
    await panel.click('Run', review);
    expect(panel.calls('db.execute')[0]).toMatchObject({
      sql: 'DROP TABLE orders CASCADE',
      confirmName: 'orders',
    });
  });

  it('empties a table with TRUNCATE once its name is typed, and shows a failure', async () => {
    const panel = await start({ failing: true });
    await panel.open('Shop', 'Tables');
    await panel.menu('orders', 'Empty table…');
    const editor = panel.dialog('Empty orders');
    const empty = panel.buttons('Empty', editor).at(-1)!;
    expect(empty.disabled).toBe(true);
    await change(
      panel,
      panel.control('Type orders to confirm', editor) as HTMLInputElement,
      'orders',
    );
    await panel.click(/^Empty$/, editor);
    expect(panel.calls('db.execute')[0]).toMatchObject({
      sql: 'TRUNCATE TABLE public.orders',
      confirmName: 'orders',
    });
    expect(panel.dialog('Empty orders').textContent).toContain('permission denied');
    await panel.click('Cancel', panel.dialog('Empty orders'));
    expect(panel.section().structureRequest()).toBeUndefined();
  });
});
