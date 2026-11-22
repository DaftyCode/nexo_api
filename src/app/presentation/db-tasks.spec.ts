import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../domain/models';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';

const doc = (
  id: string,
  kind: string,
  name: string,
  value: Record<string, unknown>,
): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind,
  name,
  revision: 1,
  updated_at: 0,
  value,
});
const SCRIPT = doc('s1', 'sql-script', 'Clean up', { text: 'delete from logs', connection: 'c1' });
const NIGHTLY = doc('t1', 'db-task', 'Nightly', {
  type: 'script',
  folder: 'Reports',
  scripts: ['s1'],
  connections: ['c1'],
  onError: 'stop',
  transaction: false,
  authorize: { everyRow: true },
  schedule: { every: 2, unit: 'hours' },
});
const HISTORY = doc('t1~history', 'monitor-history', 'Nightly', {
  runs: [
    {
      startedAt: 2,
      duration: 30,
      trigger: 'schedule',
      state: 'failed',
      statements: 1,
      rows: 0,
      error: 'boom',
      statement: 'delete from logs',
    },
    { startedAt: 1, duration: 20, trigger: 'manual', state: 'passed', statements: 1, rows: 3 },
  ],
});

async function open(documents: WorkspaceDocument[] = [SCRIPT, NIGHTLY, HISTORY]) {
  const panel = await startDbPanel({
    documents,
    responses: {
      'monitor.status': () => ({
        monitors: [],
        tasks: [{ id: 't1', running: false, next: 7_200_000 }],
      }),
      'db.task.run': () => ({
        startedAt: 3,
        duration: 5,
        trigger: 'manual',
        state: 'passed',
        statements: 2,
        rows: 4,
      }),
    },
  });
  (panel.root().querySelector('[aria-label="Database tasks"]') as HTMLButtonElement).click();
  await panel.settle();
  return { panel, dialog: () => panel.dialog('Database tasks') };
}
const rowOf = (panel: DbPanelTest, name: string) =>
  [...panel.dialog('Database tasks').querySelectorAll('tbody tr')].find((row) =>
    row.querySelector('th')?.textContent?.includes(name),
  )!;
const rows = (panel: DbPanelTest) =>
  [...panel.dialog('Database tasks').querySelectorAll('tbody tr')].map(
    (row) => row.textContent ?? '',
  );

describe('database tasks', () => {
  it('lists the tasks with their schedule, next and last run, warning and history', async () => {
    const { panel, dialog } = await open();
    const [row] = rows(panel);
    expect(row).toContain('Nightly');
    expect(row).toContain('SQL scripts');
    expect(row).toContain('Authorized without asking');
    expect(row).toContain('Reports');
    expect(row).toContain('Every 2 hours');
    expect(row).toContain('Failed');
    expect(panel.calls('monitor.status')).toEqual([{ workspace: 'local', after: 0 }]);
    await panel.click('History', dialog());
    const history = dialog().querySelector('.db-tasks-runs')!.textContent ?? '';
    expect(history).toContain('boom');
    expect(history).toContain('delete from logs');
    expect(history).toContain('1 statements, 3 rows');
    await panel.click('History', dialog());
    expect(dialog().querySelector('.db-tasks-runs')).toBeNull();
  });

  it('creates a task in the editor, only once it has what it runs', async () => {
    const { panel, dialog } = await open([SCRIPT]);
    expect(dialog().textContent).toContain('No tasks yet.');
    await panel.click('New task', dialog());
    const save = () => panel.buttons(/^Save$/, dialog())[0] as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(dialog().textContent).toContain('Give the task a name');
    await panel.fill('Name', 'Clean', dialog());
    (panel.control('Clean up', dialog()) as HTMLInputElement).click();
    (panel.control('Shop', dialog()) as HTMLInputElement).click();
    await panel.settle();
    (panel.control('After a failure', dialog()) as HTMLSelectElement).value = 'continue';
    panel.control('After a failure', dialog()).dispatchEvent(new Event('change'));
    (panel.control('Changes on connections', dialog()) as HTMLInputElement).click();
    await panel.settle();
    expect(dialog().textContent).toContain('without anybody confirming it');
    const runs = panel.control('Runs', dialog()) as HTMLSelectElement;
    runs.value = '30';
    runs.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(dialog().textContent).toContain('only while Nexo is open');
    expect(save().disabled).toBe(false);
    save().click();
    await panel.settle();
    const saved = panel.api.documentsStore.find((d) => d.kind === 'db-task')!;
    expect(saved.name).toBe('Clean');
    expect(saved.value).toEqual({
      type: 'script',
      authorize: { writes: true },
      schedule: { every: 30, unit: 'minutes' },
      scripts: ['s1'],
      connections: ['c1'],
      onError: 'continue',
      transaction: false,
    });
    expect(rows(panel)[0]).toContain('Every 30 minutes');
  });

  it('edits each type of task, and cancels', async () => {
    const { panel, dialog } = await open();
    await panel.click('Edit', dialog());
    expect((panel.control('Name', dialog()) as HTMLInputElement).value).toBe('Nightly');
    const type = panel.control('Task', dialog()) as HTMLSelectElement;
    for (const [value, field] of [
      ['copy', 'Query that reads'],
      ['compare', 'Compare'],
      ['backup', 'File of the backup'],
      ['composite', 'Tasks, in this order'],
    ]) {
      type.value = value!;
      type.dispatchEvent(new Event('change'));
      await panel.settle();
      expect(dialog().textContent).toContain(field);
    }
    expect(dialog().textContent).toContain('Save other tasks first.');
    type.value = 'backup';
    type.dispatchEvent(new Event('change'));
    await panel.settle();
    const connection = panel.control('Connection', dialog()) as HTMLSelectElement;
    connection.value = 'c1';
    connection.dispatchEvent(new Event('change'));
    await panel.fill('File of the backup', 'shop.dump', dialog());
    await panel.click(/^Save$/, dialog());
    expect(panel.api.documentsStore.find((d) => d.id === 't1')!.value).toMatchObject({
      type: 'backup',
      connection: 'c1',
      file: 'shop.dump',
      folder: 'Reports',
    });
    await panel.click('Edit', dialog());
    await panel.click('Cancel', dialog());
    expect(dialog().querySelector('form')).toBeNull();
  });

  it('fills the sides of a comparison and copies', async () => {
    const { panel, dialog } = await open();
    await panel.click('Duplicate', dialog());
    expect((panel.control('Name', dialog()) as HTMLInputElement).value).toBe('Nightly 2');
    const type = panel.control('Task', dialog()) as HTMLSelectElement;
    type.value = 'compare';
    type.dispatchEvent(new Event('change'));
    await panel.settle();
    for (const select of dialog().querySelectorAll<HTMLSelectElement>('select')) {
      if ([...select.options].some((option) => option.value === 'c1')) {
        select.value = 'c1';
        select.dispatchEvent(new Event('change'));
      }
    }
    const mode = panel.control('Compare', dialog()) as HTMLSelectElement;
    mode.value = 'data';
    mode.dispatchEvent(new Event('change'));
    const paths = dialog().querySelectorAll<HTMLInputElement>(
      'input[placeholder="shop/schemas/public"]',
    );
    for (const [at, input] of [...paths].entries()) {
      input.value = at ? 'shop/copy' : 'shop/people';
      input.dispatchEvent(new Event('input'));
    }
    await panel.settle();
    await panel.click(/^Save$/, dialog());
    const copy = panel.api.documentsStore.find((d) => d.name === 'Nightly 2')!;
    expect(copy.value).toMatchObject({
      type: 'compare',
      mode: 'data',
      source: { connection: 'c1', path: ['shop', 'people'], table: 'people' },
      target: { connection: 'c1', path: ['shop', 'copy'], table: 'copy' },
    });
    await panel.click('Edit', dialog());
    const kind = panel.control('Task', dialog()) as HTMLSelectElement;
    kind.value = 'copy';
    kind.dispatchEvent(new Event('change'));
    await panel.settle();
    for (const select of [
      panel.control('Read from', dialog()),
      panel.control('Write into', dialog()),
    ]) {
      (select as HTMLSelectElement).value = 'c1';
      select.dispatchEvent(new Event('change'));
    }
    await panel.fill('Query that reads', 'select * from people', dialog());
    await panel.fill('Schema', 'archive', dialog());
    await panel.fill('Table', 'people', dialog());
    (panel.control('Paused', dialog()) as HTMLInputElement).click();
    await panel.settle();
    await panel.click(/^Save$/, dialog());
    expect(panel.api.documentsStore.find((d) => d.id === 't1')!.value).toMatchObject({
      type: 'copy',
      sql: 'select * from people',
      schema: 'archive',
      table: 'people',
      paused: true,
    });
  });

  it('chains other tasks, runs one now and deletes it with its history', async () => {
    const { panel, dialog } = await open();
    await panel.click('New task', dialog());
    await panel.fill('Name', 'All', dialog());
    const type = panel.control('Task', dialog()) as HTMLSelectElement;
    type.value = 'composite';
    type.dispatchEvent(new Event('change'));
    await panel.settle();
    (panel.control('Nightly', dialog()) as HTMLInputElement).click();
    (panel.control('Nightly', dialog()) as HTMLInputElement).click();
    (panel.control('Nightly', dialog()) as HTMLInputElement).click();
    await panel.settle();
    await panel.click(/^Save$/, dialog());
    expect(panel.api.documentsStore.find((d) => d.name === 'All')!.value).toMatchObject({
      tasks: ['t1'],
    });
    await panel.click('Run', rowOf(panel, 'Nightly'));
    expect(panel.calls('db.task.run')).toEqual([{ workspace: 'local', id: 't1' }]);
    expect(dialog().querySelector('.db-tasks-runs')).not.toBeNull();
    panel.api.responses['db.task.run'] = () => {
      throw new Error('This task is still running');
    };
    await panel.click('Run', dialog());
    expect(panel.state.toast()).toMatchObject({ title: 'The task could not run' });
    const before = panel.api.documentsStore.length;
    await panel.click('Delete', dialog());
    expect(panel.api.documentsStore.length).toBe(before - 1);
    panel.state.confirm = () => false;
    await panel.click('Delete', dialog());
    expect(panel.api.documentsStore.length).toBe(before - 1);
    (dialog().querySelector('[aria-label="Close"]') as HTMLButtonElement).click();
    await panel.settle();
    expect(() => panel.dialog('Database tasks')).toThrow();
  });
});
