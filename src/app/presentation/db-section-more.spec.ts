import { describe, expect, it } from 'vitest';
import { installedModule, node, startDbPanel } from '../testing/db-panel';
import { typeCode } from '../testing/controls';

const script = {
  id: 'doc1',
  workspace_id: 'local',
  kind: 'sql-script',
  name: 'Totals',
  revision: 1,
  updated_at: 0,
  value: { connectionId: 'c1', sql: 'SELECT 42', database: 'archive' },
};

describe('the database section, at its edges', () => {
  it('opens a saved script unchanged from its document, and on its own database', async () => {
    const panel = await startDbPanel({
      documents: [script],
      tabs: [
        { id: 's1', kind: 'sql', title: 'Totals' },
        { id: 's2', kind: 'sql', title: 'Gone' },
      ],
      drafts: {
        s1: { text: '', cursor: 0, script: 'doc1' },
        s2: { text: '', cursor: 0, script: 'deleted' },
      },
    });
    expect(panel.section().tabs.draft('s1').text).toBe('SELECT 42');
    expect(panel.section().tabs.draft('s2')).toMatchObject({ dirty: true });
    panel.section().openScript('doc1');
    await panel.settle();
    expect(panel.section().tabs.active()?.id).toBe('s1');
    panel.section().openScript('nothing');
    panel.section().newScript('gone');
    expect(panel.section().typeOf('gone').id).toBe('development');
    expect(panel.section().rulesOf('gone').confirmWrites).toBe(false);
  });

  it('views the data of a table of another database on that database', async () => {
    const panel = await startDbPanel({
      connection: { driver: 'mssql', host: 'db', database: 'shop' },
      modules: [installedModule('mssql', 'SQL Server')],
      tree: {
        '': [node('folder', 'databases', { label: 'Databases' })],
        databases: [node('database', 'archive'), node('database', 'shop')],
        'databases/archive': [node('folder', 'tables', { label: 'Tables' })],
        'databases/archive/tables': [node('table', 'old')],
      },
      responses: {
        'db.execute': () => ({ columns: [], rows: [], elapsedMs: 1 }),
        'db.split': () => ({ statements: [], current: null }),
      },
    });
    await panel.open('Shop', 'Databases', 'archive', 'Tables');
    await panel.menu('old', 'View data');
    expect(panel.section().tabs.draft(panel.section().tabs.activeId())).toMatchObject({
      database: 'archive',
    });
  });

  it('offers the download of a module that is not installed, and stops when it is declined', async () => {
    const panel = await startDbPanel({
      modules: [{ ...installedModule(), state: 'available' }],
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
      responses: {
        'db.split': () => ({
          statements: [
            {
              text: 'select 1',
              start: 0,
              end: 8,
              line: 1,
              classification: {
                kind: 'read',
                missingWhere: false,
                truncate: false,
                drop: [],
                drops: false,
              },
            },
          ],
          current: 0,
        }),
      },
    });
    typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, 'select 1');
    await panel.settle();
    await panel.click(/^▶ Run$/);
    const dialog = panel.root().querySelector('app-module-download');
    expect(dialog?.textContent).toContain('SHA-256');
    await panel.click(/^Cancel$/, dialog as HTMLElement);
    expect(panel.root().querySelector('app-module-download')).toBeNull();
    expect(panel.calls('db.execute')).toEqual([]);
  });
});
