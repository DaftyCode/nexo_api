import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, typeCode } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from './db-panel';
import { WorkspaceState } from './workspace-state';

const module = {
  id: 'postgres',
  name: 'PostgreSQL',
  description: '',
  version: '0.7.0',
  state: 'installed',
  downloadSize: 1,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
};
const connection = (type = 'development'): WorkspaceDocument => ({
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Shop',
  revision: 1,
  updated_at: 0,
  value: { driver: 'postgres', host: 'db', database: 'shop', type },
});

/** Splits as the backend does for these tests: by semicolons, classified by their verb. */
function split(payload: Record<string, unknown>) {
  const script = String(payload['script']);
  const statements: unknown[] = [];
  let start = 0;
  for (const part of script.split(';')) {
    const text = part.trim();
    if (text) {
      const from = start + part.indexOf(text);
      const verb = text.split(/\s/)[0].toLowerCase();
      statements.push({
        text,
        start: from,
        end: from + text.length,
        line: script.slice(0, from).split('\n').length,
        classification: {
          kind: verb === 'select' ? 'read' : 'write',
          missingWhere: verb === 'delete' && !/where/i.test(text),
          truncate: false,
          drop: [],
          drops: false,
        },
      });
    }
    start += part.length + 1;
  }
  const offset = Number(payload['offset'] ?? -1);
  const current = statements.findIndex((statement) => (statement as { end: number }).end >= offset);
  return { statements, current: current < 0 ? null : current };
}

describe('DbSqlTab', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  let runs = 0;
  let auto = true;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 10; i++) await fixture.whenStable();
  };
  const calls = (operation: string) =>
    api.calls.filter((call) => call.operation === operation).map((call) => call.payload);
  const resultTabs = () =>
    [...root().querySelectorAll('[aria-label="Results"] [role="tab"]')].map((tab) =>
      tab.textContent?.trim(),
    );
  async function openScript(text: string) {
    await clickButton(fixture, '＋ SQL');
    await settle();
    typeCode(root().querySelector('.cm-content[aria-label="SQL script"]')!, text);
    await settle();
  }

  async function start(type = 'development') {
    auto = true;
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '18', database: 'shop', tls: false }),
        'db.transaction': (payload: Record<string, unknown>) => {
          if (payload['action'] === 'manual') auto = false;
          if (payload['action'] === 'auto') auto = true;
          return { autoCommit: auto, open: !auto };
        },
        'db.split': split,
        'db.execute': (payload: Record<string, unknown>) => {
          runs++;
          const sql = String(payload['sql']);
          if (/^select/i.test(sql))
            return {
              columns: [{ name: 'n', typeName: 'int4', kind: 'integer' }],
              rows: [[runs]],
              elapsedMs: 1,
            };
          return { columns: [], rows: [], affected: 2, elapsedMs: 1 };
        },
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push(connection(type));
    await state.refresh();
    state.databaseSession.set({
      expanded: [],
      active: 'c1',
      bookmarks: [],
      simple: true,
      tabs: [],
      activeTab: '',
      drafts: {},
    });
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  }

  it('runs on its own session and keeps a result tab per query', async () => {
    await start();
    await openScript('select 1; select 2; update t set a = 1');
    await clickButton(fixture, 'Script');
    await settle();
    expect(calls('db.connect')[0]).toEqual(
      expect.objectContaining({ session: expect.stringMatching(/^editor:/) }),
    );
    expect(calls('db.execute').map((payload) => payload['sql'])).toEqual([
      'select 1',
      'select 2',
      'update t set a = 1',
    ]);
    expect(resultTabs()).toEqual(['1 · select 1', '2 · select 2', 'Messages (1)']);
    await clickButton(fixture, /Messages/);
    expect(root().textContent).toContain('2 rows changed');
  });

  it('asks before a change of every row on production, with manual commits', async () => {
    await start('production');
    await openScript('delete from orders');
    await clickButton(fixture, 'Run');
    await settle();
    const dialog = root().querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('no WHERE');
    expect(calls('db.execute')).toHaveLength(0);
    buttons(dialog, 'Run')[0].click();
    await settle();
    expect(calls('db.execute')[0]).toEqual(expect.objectContaining({ confirm: true }));
    expect(calls('db.transaction')[0]).toEqual(expect.objectContaining({ action: 'manual' }));
    expect(buttons(root(), 'Commit')).toHaveLength(1);
  });

  it('saves the script, lists it in the navigator and keeps its tab in the session', async () => {
    await start();
    await openScript('select 1');
    await clickButton(fixture, 'Save');
    await settle();
    const dialog = root().querySelector<HTMLElement>('[role="dialog"]')!;
    const name = dialog.querySelector('input')!;
    name.value = 'Totals';
    name.dispatchEvent(new Event('input'));
    await settle();
    buttons(dialog, 'Save')[0].click();
    await settle();
    const script = api.documentsStore.find((document) => document.kind === 'sql-script')!;
    expect(script.value).toEqual({ connectionId: 'c1', sql: 'select 1' });
    expect(root().querySelector('[role="tree"]')?.textContent).toContain('Totals');
    const session = state.databaseSession()!;
    expect(session.tabs.map((tab) => tab.kind)).toEqual(['sql']);
    // A saved script that did not change reopens from its document.
    expect(Object.values(session.drafts)[0]).toEqual(
      expect.objectContaining({ script: script.id, text: '' }),
    );
  });
});
