import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, typeCode } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from './db-panel';
import { DbSection } from './db-panel/section';
import { WorkspaceState } from './workspace-state';

const module = {
  id: 'mysql',
  name: 'MySQL',
  description: '',
  version: '0.7.0',
  state: 'installed',
  downloadSize: 1,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
};
const connection = (value: Record<string, unknown>): WorkspaceDocument => ({
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Shop',
  revision: 1,
  updated_at: 0,
  value: { driver: 'mysql', host: 'db', database: 'shop', ...value },
});

/** One statement per call, classified by its verb as the backend does. */
function split(payload: Record<string, unknown>) {
  const text = String(payload['script']).trim();
  const verb = text.split(/\s/)[0].toLowerCase();
  const kind = verb === 'select' ? 'read' : verb === 'create' ? 'structure' : 'write';
  return {
    statements: [
      {
        text,
        start: 0,
        end: text.length,
        line: 1,
        classification: { kind, missingWhere: false, truncate: false, drop: [], drops: false },
      },
    ],
    current: 0,
  };
}

describe('the transactions of a SQL tab', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  /** The driver's transaction, as the backend keeps it. */
  let state = { autoCommit: true, open: false, statements: 0, writes: 0, since: 0 };
  /** The session the tab runs on. */
  let session = '';
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 12; i++) await fixture.whenStable();
  };
  const actions = () =>
    api.calls
      .filter((call) => call.operation === 'db.transaction' || call.operation === 'db.execute')
      .map((call) => String(call.payload['action'] ?? call.payload['sql']));
  async function run(text: string) {
    typeCode(root().querySelector('.cm-content[aria-label="SQL script"]')!, text);
    await settle();
    await clickButton(fixture, 'Run');
    await settle();
  }

  async function start(value: Record<string, unknown> = {}) {
    state = { autoCommit: true, open: false, statements: 0, writes: 0, since: 0 };
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '8.4', database: 'shop', tls: false }),
        'db.dialect': () => ({
          driver: { id: 'mysql', name: 'MySQL', version: '1' },
          capabilities: {
            transactions: true,
            isolationLevels: ['read committed', 'serializable'],
            ddlCommits: true,
          },
          dialect: { name: 'mysql', quoteOpen: '`', quoteClose: '`', parameters: 'question' },
        }),
        'db.split': split,
        'db.transaction': (payload: Record<string, unknown>) => {
          const action = payload['action'];
          if (action === 'manual') state.autoCommit = false;
          if (action === 'auto') state.autoCommit = true;
          if (action === 'begin') state = { ...state, open: true, since: Date.now() };
          if (action === 'commit' || action === 'rollback' || action === 'auto')
            state = { ...state, open: false, statements: 0, writes: 0, since: 0 };
          return { ...state };
        },
        'db.execute': (payload: Record<string, unknown>) => {
          const sql = String(payload['sql']);
          session = String(payload['session']);
          if (!state.autoCommit) {
            state.open = true;
            state.since ||= Date.now();
            state.statements++;
            if (!/^select/i.test(sql)) state.writes++;
          }
          return /^select/i.test(sql)
            ? {
                columns: [{ name: 'n', typeName: 'int', kind: 'integer' }],
                rows: [[1]],
                elapsedMs: 1,
              }
            : { columns: [], rows: [], affected: 1, elapsedMs: 1 };
        },
        'db.transactions': () => ({
          sessions: state.open
            ? [
                {
                  session,
                  connection: 'c1',
                  name: 'Shop',
                  autoCommit: state.autoCommit,
                  since: state.since,
                  statements: state.statements,
                  writes: state.writes,
                  log: [{ sql: 'update t set a = 1', at: state.since, ms: 3, affected: 1 }],
                },
              ]
            : [],
        }),
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    const workspace = TestBed.inject(WorkspaceState);
    workspace.workspaceId.set('local');
    api.documentsStore.push(connection(value));
    await workspace.refresh();
    workspace.databaseSession.set({
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
    await clickButton(fixture, 'New SQL script');
    await settle();
  }

  it('counts the statements of a manual transaction and shows its log', async () => {
    await start({ autoCommit: false });
    await run('update t set a = 1');
    const commit = buttons(root(), 'Commit')[0];
    expect(commit.disabled).toBe(false);
    expect(commit.textContent).toContain('1');
    expect(root().querySelector('[aria-label="Isolation level"]')).not.toBeNull();
    await clickButton(fixture, 'Transaction log');
    await settle();
    const log = root().querySelector<HTMLElement>('[role="dialog"]')!;
    expect(log.textContent).toContain('update t set a = 1');
    buttons(log, 'Close')[0].click();
    await settle();
    commit.click();
    await settle();
    expect(actions().slice(-1)).toEqual(['commit']);
    expect(buttons(root(), 'Commit')[0].disabled).toBe(true);
  });

  it('switches to manual commit before a write, with smart commit', async () => {
    await start({ smartCommit: true });
    await run('update t set a = 1');
    expect(actions()).toEqual(['status', 'manual', 'update t set a = 1', 'status']);
    await clickButton(fixture, /Messages/);
    expect(root().textContent).toContain('Switched to manual commit');
  });

  it('begins with the chosen isolation level, and asks before a change of structure', async () => {
    await start({ autoCommit: false });
    // The select appears once the session is open.
    await run('select 1');
    await clickButton(fixture, 'Rollback');
    await settle();
    const isolation = root().querySelector<HTMLSelectElement>('[aria-label="Isolation level"]')!;
    isolation.value = 'serializable';
    isolation.dispatchEvent(new Event('change'));
    await run('update t set a = 2');
    const begin = api.calls.find((call) => call.payload['action'] === 'begin');
    expect(begin?.payload['isolation']).toBe('serializable');
    // MySQL commits what is pending before DDL: it asks, and nothing runs without a yes.
    await run('create table x (a int)');
    const dialog = root().querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('commits what is pending');
    buttons(dialog, 'Cancel')[0].click();
    await settle();
    expect(actions()).not.toContain('create table x (a int)');
  });

  it('asks before closing a tab with changes, and does what is chosen', async () => {
    await start({ autoCommit: false });
    await run('update t set a = 1');
    const close = () => root().querySelector<HTMLElement>('[role="tab"] .db-tab-close')!.click();
    close();
    await settle();
    let dialog = root().querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Changes not committed');
    buttons(dialog, 'Cancel')[0].click();
    await settle();
    expect(root().querySelectorAll('[role="tab"].db-tab')).toHaveLength(1);
    close();
    await settle();
    dialog = root().querySelector<HTMLElement>('[role="dialog"]')!;
    buttons(dialog, 'Rollback')[0].click();
    await settle();
    expect(actions()).toContain('rollback');
    expect(root().querySelectorAll('[role="tab"].db-tab')).toHaveLength(0);
  });

  it('points out a transaction open too long, and rolls it back when asked to', async () => {
    await start({ autoCommit: false });
    await run('update t set a = 1');
    const section = fixture.debugElement.children[0].injector.get(DbSection);
    state.since = Date.now() - 12 * 60_000;
    await section.transactions.tick();
    await clickButton(fixture, 'Rollback');
    await settle();
    await run('update t set a = 2');
    state.since = Date.now() - 12 * 60_000;
    section.transactions.limits.set({ warnMinutes: 10, rollbackMinutes: 0 });
    await section.runner(section.tabs.activeId()).refreshTransaction();
    await section.transactions.tick();
    await settle();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('open for 12 minutes');
    section.transactions.limits.set({ warnMinutes: 10, rollbackMinutes: 11 });
    await section.transactions.tick();
    await settle();
    expect(actions().slice(-1)).toEqual(['rollback']);
    expect(root().querySelector('.db-sql-long')).toBeNull();
  });

  it('shares one session between the SQL tabs of a connection that asks for it', async () => {
    await start({ sharedSession: true });
    await run('select 1');
    await clickButton(fixture, 'New SQL script');
    await settle();
    await run('select 2');
    const connects = api.calls.filter((call) => call.operation === 'db.connect');
    expect(connects.map((call) => call.payload['session'])).toEqual(['editor-shared:c1']);
    const sessions = api.calls
      .filter((call) => call.operation === 'db.execute')
      .map((call) => call.payload['session']);
    expect(sessions).toEqual(['editor-shared:c1', 'editor-shared:c1']);
  });
});
