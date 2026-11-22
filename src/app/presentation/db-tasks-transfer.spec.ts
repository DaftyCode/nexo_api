import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../domain/models';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';

const doc = (id: string, kind: string, name: string, value: Record<string, unknown>) =>
  ({
    id,
    workspace_id: 'local',
    kind,
    name,
    revision: 1,
    updated_at: 0,
    value,
  }) as WorkspaceDocument;
const TO_FILE = doc('tr', 'mongo-transfer', 'Orders to a file', {
  direction: 'export',
  destination: 'file',
});
const COPY = doc('cp', 'mongo-transfer', 'Orders copy', {
  direction: 'export',
  destination: 'collection',
});
const COMPARISON = doc('cmp', 'mongo-compare', 'Orders ↔ copy', {});

async function open(documents: WorkspaceDocument[]) {
  const panel = await startDbPanel({
    documents,
    responses: { 'monitor.status': () => ({ tasks: [] }) },
  });
  (panel.root().querySelector('[aria-label="Database tasks"]') as HTMLButtonElement).click();
  await panel.settle();
  const dialog = () => panel.dialog('Database tasks');
  await panel.click('New task', dialog());
  await panel.fill('Name', 'Nightly', dialog());
  return { panel, dialog };
}
const choose = async (panel: DbPanelTest, root: HTMLElement, label: string, value: string) => {
  const select = panel.control(label, root) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('change'));
  await panel.settle();
};
const saved = (panel: DbPanelTest) =>
  panel.api.documentsStore.find((document) => document.kind === 'db-task')!.value;

describe('database tasks with files and MongoDB', () => {
  it('exports a query to a file on a cron expression', async () => {
    const { panel, dialog } = await open([]);
    await choose(panel, dialog(), 'Task', 'export');
    expect(dialog().textContent).toContain('outside Nexo');
    await choose(panel, dialog(), 'Connection', 'c1');
    await choose(panel, dialog(), 'Format', 'json');
    await panel.fill('Query that reads', 'select * from orders', dialog());
    await panel.fill('File', 'C:/out/orders-{date}.json', dialog());
    (panel.control('Replace the file when it exists', dialog()) as HTMLInputElement).click();
    await choose(panel, dialog(), 'Runs', '-1');
    expect((panel.control('Cron expression', dialog()) as HTMLInputElement).value).toBe(
      '0 9 * * *',
    );
    await panel.fill('Cron expression', '0 9 *', dialog());
    expect(dialog().textContent).toContain('A cron expression has five fields');
    await panel.fill('Cron expression', '30 6 * * mon-fri', dialog());
    await panel.click(/^Save$/, dialog());
    expect(saved(panel)).toEqual({
      type: 'export',
      connection: 'c1',
      sql: 'select * from orders',
      format: 'json',
      file: 'C:/out/orders-{date}.json',
      overwrite: true,
      schedule: { cron: '30 6 * * mon-fri' },
    });
    expect(panel.dialog('Database tasks').textContent).toContain('On 30 6 * * mon-fri');
  });

  it('imports a CSV file by key into a table', async () => {
    const { panel, dialog } = await open([]);
    await choose(panel, dialog(), 'Task', 'import');
    await choose(panel, dialog(), 'Connection', 'c1');
    await panel.fill('File', '/in/people.csv', dialog());
    await panel.fill('Table', 'people', dialog());
    await choose(panel, dialog(), 'Mode', 'upsert');
    await panel.fill('Columns of the key', 'id', dialog());
    await panel.fill('Separator', ';', dialog());
    expect(dialog().textContent).not.toContain('Replace the file');
    await panel.click(/^Save$/, dialog());
    expect(saved(panel)).toMatchObject({
      type: 'import',
      table: 'people',
      mode: 'upsert',
      key: ['id'],
      separator: ';',
    });
  });

  it('runs a saved MongoDB transfer or comparison', async () => {
    const { panel, dialog } = await open([TO_FILE, COPY, COMPARISON]);
    await choose(panel, dialog(), 'Task', 'mongo-transfer');
    expect(dialog().textContent).not.toContain('Replace the file');
    await choose(panel, dialog(), 'Saved transfer', 'cp');
    expect(dialog().querySelector('input[placeholder^="C:/exports"]')).toBeNull();
    await choose(panel, dialog(), 'Saved transfer', 'tr');
    await panel.fill('File', '/out/orders.jsonl', dialog());
    await panel.click(/^Save$/, dialog());
    expect(saved(panel)).toEqual({
      type: 'mongo-transfer',
      transfer: 'tr',
      file: '/out/orders.jsonl',
    });

    panel.api.documentsStore.splice(
      panel.api.documentsStore.findIndex((d) => d.kind === 'db-task'),
      1,
    );
    await panel.click('New task', dialog());
    await panel.fill('Name', 'Compare', dialog());
    await choose(panel, dialog(), 'Task', 'mongo-compare');
    await choose(panel, dialog(), 'Saved comparison', 'cmp');
    (panel.control('Make the target like the source', dialog()) as HTMLInputElement).click();
    await panel.settle();
    await panel.click(/^Save$/, dialog());
    expect(saved(panel)).toEqual({ type: 'mongo-compare', comparison: 'cmp', sync: true });
  });

  it('says when nothing of MongoDB is saved yet', async () => {
    const { panel, dialog } = await open([]);
    await choose(panel, dialog(), 'Task', 'mongo-transfer');
    expect(dialog().textContent).toContain('Save a transfer first in the MongoDB section');
    await choose(panel, dialog(), 'Task', 'mongo-compare');
    expect(dialog().textContent).toContain('Save a comparison first in the MongoDB section');
  });
});
