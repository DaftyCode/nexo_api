import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeFilesPort } from '../application/ports';
import { startDbPanel } from '../testing/db-panel';

/** The desktop dialogs, answering what each test chooses. */
function dialogs(answers: (string | undefined)[]) {
  const asked: [string, string | undefined][] = [];
  const files: NativeFilesPort = {
    available: true,
    async choose(purpose, name) {
      asked.push([purpose, name]);
      return answers.shift();
    },
  };
  return { files, asked };
}

async function nativeTab(
  answers: (string | undefined)[],
  connection?: Record<string, unknown>,
  runs: unknown[] = [
    { tool: 'pg_dump', state: 'finished', lines: ['done'], dropped: 0, seconds: 2 },
  ],
) {
  const { files, asked } = dialogs(answers);
  const panel = await startDbPanel({
    connection,
    nativeFiles: files,
    responses: {
      'native.locate': () => ({
        tool: 'pg_dump',
        path: 'C:/pg/bin/pg_dump.exe',
        version: 'pg_dump (PostgreSQL) 16.4',
      }),
      'native.backup': () => ({
        id: 'run-1',
        tool: 'pg_dump',
        version: 'pg_dump (PostgreSQL) 16.4',
      }),
      'native.restore': () => ({ id: 'run-2', tool: 'pg_restore', version: '16.4' }),
      'native.script': () => ({ id: 'run-3', tool: 'psql', version: '16.4' }),
      'native.status': () =>
        runs.shift() ?? { tool: 'pg_dump', state: 'finished', lines: [], dropped: 0, seconds: 1 },
      'native.cancel': () => ({ cancelled: true }),
    },
  });
  await panel.menu('Shop', 'Backup and restore…');
  await panel.settle();
  return { panel, asked };
}

describe('DbNative', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs up with the options chosen and follows the run until it ends', async () => {
    const { panel, asked } = await nativeTab(['C:/backups/shop.dump'], undefined, [
      { tool: 'pg_dump', state: 'running', lines: ['dumping'], dropped: 0, seconds: 1 },
      { tool: 'pg_dump', state: 'finished', lines: ['dumping', 'done'], dropped: 3, seconds: 4 },
    ]);
    expect(panel.section().tabs.active()).toMatchObject({
      kind: 'native',
      title: 'Backup and restore',
    });
    expect(panel.text()).toContain('Shop · Backup and restore');
    await panel.click('Find the tool');
    expect(panel.calls('native.locate')[0]).toEqual({
      workspace: 'local',
      connection: 'c1',
      need: 'backup',
    });
    expect(panel.text()).toContain('Found: pg_dump (PostgreSQL) 16.4 (C:/pg/bin/pg_dump.exe)');
    // The server said it is version 18: the tools are older.
    await panel.open('Shop');
    expect(panel.text()).toContain('The tools found are older than the server');
    await panel.fill('Format', 'custom');
    await panel.fill(
      'Only these tables (schema.table, separated by commas)',
      'public.my table, orders',
    );
    (panel.control('Without owners') as HTMLInputElement).click();
    await panel.fill('Time limit (minutes, empty for none)', '2');
    await panel.click('Choose the file and back up');
    expect(asked).toEqual([['save', 'shop.dump']]);
    expect(panel.calls('native.backup')[0]).toMatchObject({
      connection: 'c1',
      timeoutSeconds: 120,
      options: {
        path: 'C:/backups/shop.dump',
        format: 'custom',
        noOwner: true,
        tables: [{ schema: 'public', name: 'my table' }, 'orders'],
      },
    });
    expect(panel.text()).toContain('pg_dump is running');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await panel.settle();
    expect(panel.text()).toContain('dumping');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await panel.settle();
    expect(panel.text()).toContain('pg_dump finished (4 s)');
    expect(panel.text()).toContain('The first 3 lines are not kept.');
  });

  it('restores only once the database is typed, and asks again on production', async () => {
    const asks: unknown[] = [];
    const { panel } = await nativeTab(['C:/backups/shop.tar', 'C:/backups/other.tar'], {
      driver: 'postgres',
      host: 'db',
      database: 'shop',
      type: 'production',
    });
    panel.state.confirm = (message, params) => (asks.push([message, params]), asks.length > 1);
    await panel.click('Restore');
    const start = panel.buttons('Choose the backup and restore')[0] as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await panel.fill('Type shop to restore the backup into that database', 'shop');
    expect(start.disabled).toBe(false);
    await panel.click('Choose the backup and restore');
    expect(asks).toEqual([['db.native.confirmProduction', { v0: 'Shop' }]]);
    expect(panel.calls('native.restore')).toEqual([]);
    await panel.click('Choose the backup and restore');
    expect(panel.calls('native.restore')[0]).toMatchObject({
      confirm: true,
      confirmName: 'shop',
      options: { path: 'C:/backups/other.tar', format: 'tar', singleTransaction: true },
    });
  });

  it('runs a script, cancels it and says when no file was chosen', async () => {
    const running = { tool: 'psql', state: 'running', lines: [], dropped: 0, seconds: 1 };
    const { panel, asked } = await nativeTab([undefined, 'C:/scripts/big.sql'], undefined, [
      running,
      running,
    ]);
    await panel.click('Run a script');
    (panel.control('Stop at the first error') as HTMLInputElement).click();
    await panel.click('Choose the script and run it');
    expect(asked[0][0]).toBe('open');
    expect(panel.calls('native.script')).toEqual([]);
    await panel.click('Choose the script and run it');
    expect(panel.calls('native.script')[0]).toMatchObject({
      options: { path: 'C:/scripts/big.sql', stopOnError: false },
    });
    await panel.click('Cancel');
    expect(panel.calls('native.cancel')[0]).toEqual({ id: 'run-3' });
  });

  it('is only in the desktop app', async () => {
    const panel = await startDbPanel({});
    expect(await panel.menuEntries('Shop')).not.toContain('Backup and restore…');
    panel.section().tabs.open({ kind: 'native', connection: 'c1', title: 'Backup and restore' });
    await panel.settle();
    expect(panel.text()).toContain(
      'Backups and restores with the local client tools are in the desktop app.',
    );
  });
});
