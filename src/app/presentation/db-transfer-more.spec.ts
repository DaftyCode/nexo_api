import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TRANSFER_FILES } from '../composition/providers';
import { DbPanelTest, dbConnection, startDbPanel } from '../testing/db-panel';
import { TestTransferFiles, sourceFile } from '../testing/mongo-transfer';

const columns = [
  { name: 'id', typeName: 'int4', kind: 'integer' },
  { name: 'label', typeName: 'text', kind: 'text' },
];

async function start() {
  const panel = await startDbPanel({
    responses: {
      'db.execute': (payload: Record<string, unknown>) =>
        /WHERE 1 = 0/.test(String(payload['sql']))
          ? { columns, rows: [], elapsedMs: 1 }
          : { columns, rows: [[1, 'lamp']], cursor: null, elapsedMs: 1 },
      'db.convert': (payload: Record<string, unknown>) => ({
        sql: `CREATE TABLE ${payload['table']} (id bigint, label text)`,
        columns: [
          { name: 'id', from: 'int4', type: 'bigint', asText: false },
          { name: 'label', from: 'uuid', type: 'text', asText: true },
        ],
      }),
      'db.import': (payload: Record<string, unknown>) => ({
        inserted: 0,
        upserted: (payload['rows'] as unknown[]).length,
        failed: 0,
        failures: [],
      }),
      'db.copy': (payload: Record<string, unknown>) =>
        payload['cursor']
          ? { inserted: 1, upserted: 0, failed: 0, failures: [], read: 1, cursor: null }
          : {
              inserted: 1,
              upserted: 0,
              failed: 0,
              failures: [],
              read: 1,
              cursor: 'k',
              columns: [{ name: 'id' }],
            },
    },
  });
  panel.api.documentsStore.push(
    dbConnection({ driver: 'postgres', host: 'other' }, 'c2', 'Archive'),
  );
  await panel.state.refresh();
  await panel.settle();
  const files = TestBed.inject(TRANSFER_FILES) as TestTransferFiles;
  return { panel, files };
}
function open(panel: DbPanelTest, kind: 'export' | 'import' | 'copy') {
  panel.section().transferRequest.set({
    kind,
    connection: 'c1',
    sql: 'SELECT * FROM "items"',
    name: 'items',
    table: { schema: 'public', name: 'items', qualified: '"items"' },
  });
  return panel.settle(14);
}
async function choose(panel: DbPanelTest, label: string, value: string | boolean) {
  const control = panel.control(label, panel.dialog()) as HTMLInputElement | HTMLSelectElement;
  if (typeof value === 'boolean') {
    if ((control as HTMLInputElement).checked !== value) (control as HTMLInputElement).click();
  } else {
    control.value = value;
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('change'));
  }
  await panel.settle(14);
}
const run = (panel: DbPanelTest, name: string) =>
  panel.click(new RegExp(`^${name}$`), panel.dialog()).then(() => panel.settle(20));

describe('the data transfer wizard, every way', () => {
  it('exports SQL INSERTs for another engine, beginning with their CREATE TABLE', async () => {
    const { panel, files } = await start();
    await open(panel, 'export');
    await choose(panel, 'Format', 'sql');
    await choose(panel, 'Written for', 'mysql');
    await choose(panel, 'Begin with its CREATE TABLE', true);
    await choose(panel, 'Rows in each INSERT', '50');
    await choose(panel, 'Binary values', 'hex');
    await run(panel, 'Export');
    expect(files.targets[0].name).toBe('items.sql');
    expect(files.targets[0].text).toContain('CREATE TABLE');
    expect(files.targets[0].text).toContain('INSERT INTO');
    expect(panel.calls('db.convert')[0]).toMatchObject({ targetDriver: 'mysql' });
    await panel.click(/^Close$/, panel.dialog());
    expect(panel.section().transferRequest()).toBeUndefined();
  });

  it('goes back to its setup when no file is chosen', async () => {
    const { panel, files } = await start();
    Object.defineProperty(files, 'save', { value: async () => undefined });
    await open(panel, 'export');
    await run(panel, 'Export');
    expect(files.targets).toEqual([]);
    expect(panel.dialog().textContent).not.toContain('exported');
  });

  it('imports a JSON file into a new table, upserting by its key after emptying it', async () => {
    const { panel, files } = await start();
    files.sources.push(sourceFile('more.json', '[{"id": 4, "label": "chair"}, {"id": 5}]'));
    await open(panel, 'import');
    await panel.click('Choose a file', panel.dialog());
    await panel.settle(14);
    await choose(panel, 'Into a new table', true);
    await choose(panel, 'New table', 'items_copy');
    const target = panel
      .dialog()
      .querySelector<HTMLSelectElement>('[aria-label="Where label goes"]');
    if (target) {
      target.value = '';
      target.dispatchEvent(new Event('change'));
      await panel.settle();
      target.value = 'label';
      target.dispatchEvent(new Event('change'));
    }
    const kind = panel.dialog().querySelector<HTMLSelectElement>('[aria-label^="Kind of"]');
    if (kind) {
      kind.value = 'text';
      kind.dispatchEvent(new Event('change'));
    }
    await choose(panel, 'Rows are', 'upsert');
    const key = [...panel.dialog().querySelectorAll<HTMLLabelElement>('label')].find(
      (label) =>
        label.textContent?.trim() === 'id' && label.querySelector('input[type="checkbox"]'),
    );
    key?.querySelector('input')!.click();
    await panel.settle();
    await choose(panel, 'Stop at the first failure and undo it all', false);
    await run(panel, 'Import');
    const [batch] = panel.calls('db.import');
    expect(batch).toMatchObject({ table: 'items_copy', mode: 'upsert', stopOnError: false });
    expect(panel.calls('db.execute').map((payload) => String(payload['sql']))).toContain(
      'CREATE TABLE items_copy (id bigint, label text)',
    );
    expect(panel.dialog().textContent).toContain('Inserted or updated');
  });

  it('reads a TSV file by tabs, and imports nothing when no file is chosen', async () => {
    const { panel, files } = await start();
    await open(panel, 'import');
    await panel.click('Choose a file', panel.dialog());
    expect(panel.calls('db.import')).toEqual([]);
    files.sources.push(sourceFile('more.tsv', 'id\tlabel\n7\tdesk\n'));
    await panel.click('Choose a file', panel.dialog());
    await panel.settle(14);
    expect((panel.control('Separator', panel.dialog()) as HTMLSelectElement).value).toBe('\t');
    await choose(panel, 'Trim spaces', false);
    await choose(panel, 'An empty cell is NULL', false);
    await choose(panel, 'Empty the table first', true);
    const run = panel.buttons(/^Import$/, panel.dialog())[0];
    expect(run.disabled).toBe(true);
    await choose(panel, 'Type items to empty it', 'items');
    expect(panel.buttons(/^Import$/, panel.dialog())[0].disabled).toBe(false);
  });

  it('copies a table to another connection, creating it there', async () => {
    const { panel } = await start();
    await open(panel, 'copy');
    await choose(panel, 'Target connection', 'c2');
    const created = panel.dialog().querySelector('[aria-label="The table it creates"]');
    expect(created?.textContent ?? panel.dialog().textContent).toContain('CREATE TABLE');
    expect(panel.dialog().textContent).toContain('label');
    await choose(panel, 'Create the table', true);
    await run(panel, 'Copy');
    const pages = panel.calls('db.copy');
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ cursor: 'k', columns: ['id'] });
    expect(panel.dialog().textContent).toMatch(/2 rows|Read/);
  });
});
