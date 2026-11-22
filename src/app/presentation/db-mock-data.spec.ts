import { describe, expect, it } from 'vitest';
import { TRANSFER_FILES } from '../composition/providers';
import type { TestTransferFiles } from '../testing/mongo-transfer';
import { DbPanelTest, driverHello, node, startDbPanel } from '../testing/db-panel';

const TABLE = {
  table: {
    schema: 'public',
    name: 'people',
    columns: [
      { name: 'id', typeName: 'int4', nullable: false, identity: false },
      { name: 'email', typeName: 'varchar(40)', nullable: false, identity: false },
      { name: 'team_id', typeName: 'int4', nullable: true, identity: false },
      { name: 'born', typeName: 'date', nullable: true, identity: false },
    ],
    primaryKey: { columns: ['id'] },
    uniques: [],
    checks: [],
    foreignKeys: [
      {
        columns: ['team_id'],
        referencedSchema: 'public',
        referencedTable: 'teams',
        referencedColumns: ['id'],
      },
    ],
    indexes: [],
  },
};

async function open(connection: Record<string, unknown> = {}) {
  const panel = await startDbPanel({
    connection: { driver: 'postgres', host: 'db', database: 'shop', ...connection },
    hello: driverHello({ methods: ['ddl.model', 'ddl.plan'] }),
    tree: {
      '': [node('database', 'shop')],
      shop: [node('folder', 'schemas')],
      'shop/schemas': [node('schema', 'public')],
      'shop/schemas/public': [node('folder', 'tables')],
      'shop/schemas/public/tables': [node('table', 'people')],
    },
    responses: {
      'db.ddl.model': () => TABLE,
      'db.execute': () => ({ columns: [{ name: 'id' }], rows: [[1], [2]], elapsedMs: 1 }),
      'db.mock.rows': (payload: Record<string, unknown>) =>
        payload['write']
          ? {
              inserted: Number(payload['count']) - 1,
              failed: 1,
              failures: [{ position: 3, error: 'duplicate' }],
            }
          : {
              columns: (payload['columns'] as { name: string }[]).map((each) => each.name),
              rows: Array.from({ length: Number(payload['count']) }, (_, at) => [
                at + 1,
                `p${at}@example.com`,
                null,
                '2024-01-01',
              ]),
            },
    },
  });
  return { panel };
}

async function menu(panel: DbPanelTest) {
  await panel.open('Shop', 'shop', 'schemas', 'public', 'tables');
  return panel.menuEntries('people');
}

describe('test data for a table', () => {
  it('previews, writes by batches with its report, and reads the keys it references', async () => {
    const { panel } = await open();
    const entries = await menu(panel);
    expect(entries).toContain('Generate test data…');
    await panel.menu('people', 'Generate test data…');
    const dialog = panel.dialog('Test data for');
    expect(dialog.textContent).toContain('team_id');
    expect(dialog.textContent).toContain('A key of teams, read before writing');
    await panel.fill('Rows', '2500');
    await panel.fill('Rows per batch', '1000');
    await panel.click(/^Preview$/);
    expect(panel.dialog('Test data for').querySelectorAll('tbody tr').length).toBeGreaterThan(20);
    const keys = panel.calls('db.execute')[0] as Record<string, unknown>;
    expect(keys['sql']).toBe('SELECT DISTINCT id FROM public.teams LIMIT 10000');
    await panel.click(/^Generate$/);
    const writes = panel
      .calls('db.mock.rows')
      .filter((call) => (call as { write?: boolean }).write);
    expect(writes.map((call) => (call as { first: number }).first)).toEqual([0, 1000, 2000]);
    expect(writes.map((call) => (call as { count: number }).count)).toEqual([1000, 1000, 500]);
    expect(panel.dialog('Test data for').textContent).toContain(
      '2497 rows written; 3 refused by the database.',
    );
    expect(panel.dialog('Test data for').textContent).toContain('Row 3: duplicate');
  });

  it('checks its options, empties the table once its name is typed, and changes generators', async () => {
    const { panel } = await open();
    await menu(panel);
    await panel.menu('people', 'Generate test data…');
    await panel.fill('Rows', '0');
    expect(panel.text()).toContain('From 1 to 1000000 rows');
    await panel.fill('Rows', '10');
    await panel.fill('Rows per batch', '9000');
    expect(panel.text()).toContain('From 1 to 5000 rows per batch');
    await panel.fill('Rows per batch', '10');
    (panel.control('Empty the table first') as HTMLInputElement).click();
    await panel.settle();
    expect(panel.text()).toContain('Type the name of the table to empty it first');
    await panel.fill('Type people to empty it', 'people');
    const kind = panel.control('Generator of born') as HTMLSelectElement;
    kind.value = 'pattern';
    kind.dispatchEvent(new Event('change'));
    await panel.settle();
    await panel.fill('Pattern: A letter, 9 digit', 'AA-99');
    await panel.click(/^Generate$/);
    const empty = panel
      .calls('db.execute')
      .find((call) => String((call as { sql: string }).sql).startsWith('TRUNCATE'));
    expect(empty).toMatchObject({ sql: 'TRUNCATE TABLE public.people', confirmName: 'people' });
    const [write] = panel.calls('db.mock.rows') as {
      columns: { name: string; generator: unknown }[];
    }[];
    expect(write.columns.find((each) => each.name === 'born')?.generator).toEqual({
      kind: 'pattern',
      pattern: 'AA-99',
    });
    (panel.control('Fill email') as HTMLInputElement).click();
    (panel.control('Fill id') as HTMLInputElement).click();
    (panel.control('Fill team_id') as HTMLInputElement).click();
    (panel.control('Fill born') as HTMLInputElement).click();
    await panel.settle();
    expect(panel.text()).toContain('Choose at least one column to fill');
  });

  it('writes the same rows as a script of INSERTs or as a CSV file', async () => {
    const { panel } = await open();
    await menu(panel);
    await panel.menu('people', 'Generate test data…');
    await panel.fill('Rows', '3');
    const files = panel.fixture.debugElement.injector.get(TRANSFER_FILES) as TestTransferFiles;
    await panel.click('As a script');
    await panel.click('As a CSV file');
    const [script, csv] = files.targets;
    expect(script.text).toContain(
      "INSERT INTO public.people (id, email, team_id, born) VALUES (1, 'p0@example.com', NULL, '2024-01-01');",
    );
    expect(script.state).toBe('closed');
    expect(csv.text.split(String.fromCharCode(10))[0]).toBe('id,email,team_id,born');
    expect(panel.calls('db.mock.rows').every((call) => !(call as { write?: boolean }).write)).toBe(
      true,
    );
  });

  it('is not offered on production nor on read-only connections', async () => {
    const { panel } = await open({ type: 'production' });
    expect(await menu(panel)).not.toContain('Generate test data…');
  });
});
