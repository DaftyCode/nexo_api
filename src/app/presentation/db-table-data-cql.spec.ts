import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { clickButton, typeCode } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from './db-panel';
import { WorkspaceState } from './workspace-state';

const module = {
  id: 'cassandra',
  name: 'Cassandra and ScyllaDB',
  description: '',
  version: '0.10.0',
  state: 'installed',
  downloadSize: 1,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
};
const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Sensors',
  revision: 1,
  updated_at: 0,
  value: { driver: 'cassandra', host: 'db', database: 'shop' },
};
const REFUSED =
  'Cannot execute this query as it might involve data filtering and thus may have unpredictable performance. If you want to execute this query despite the performance unpredictability, use ALLOW FILTERING';

/** Cassandra: a condition off the partition key needs ALLOW FILTERING, confirmed. */
function execute(payload: Record<string, unknown>) {
  const sql = String(payload['sql']);
  if (sql.includes('value') && !sql.includes('ALLOW FILTERING')) throw new Error(REFUSED);
  return {
    columns: [{ name: 'value', typeName: 'double', kind: 'float' }],
    rows: [[2.5]],
    elapsedMs: 1,
  };
}

describe('the Data tab of a Cassandra table', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((done) => setTimeout(done));
    }
  };
  const executed = () => api.calls.filter((call) => call.operation === 'db.execute');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '5.0', database: 'shop', tls: false }),
        'db.dialect': () => ({
          driver: { id: 'cassandra', name: 'Cassandra and ScyllaDB', version: '1' },
          capabilities: { schemas: true },
          dialect: { name: 'cql', quoteOpen: '"', quoteClose: '"', parameters: 'question' },
        }),
        'db.describe': () => ({
          kind: 'table',
          name: 'shop.readings',
          properties: [],
          sections: [],
        }),
        'db.execute': execute,
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    const state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push(connection);
    await state.refresh();
    state.databaseSession.set({
      expanded: [],
      active: 'c1',
      bookmarks: [],
      simple: true,
      tabs: [
        {
          id: 'o1',
          kind: 'object',
          connection: 'c1',
          title: 'readings',
          path: ['shop', 'tables', 'readings'],
          part: 'data',
        },
      ],
      activeTab: 'o1',
      drafts: {},
    });
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  });
  afterEach(() => vi.restoreAllMocks());

  it('offers ALLOW FILTERING when Cassandra asks for it, once confirmed', async () => {
    const nav = root().querySelector('[aria-label="Object views"]');
    if (nav) await clickButton(fixture, 'Data', nav);
    await settle();
    typeCode(root().querySelector('.cm-content[aria-label="Condition (WHERE)"]')!, 'value > 2');
    await settle();
    await clickButton(fixture, 'Run (F5)');
    await settle();
    expect(root().querySelector('.db-data-filtering')?.textContent).toContain(
      'Cassandra filters by the partition key',
    );
    // Refused at the question: nothing more is sent.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const before = executed().length;
    await clickButton(fixture, 'Filter with ALLOW FILTERING');
    await settle();
    expect(confirm.mock.calls[0][0]).toMatch(/^ALLOW FILTERING may read every partition/);
    expect(executed()).toHaveLength(before);
    // Confirmed: the statement ends with it, and the backend is told the person confirmed.
    confirm.mockReturnValue(true);
    await clickButton(fixture, 'Filter with ALLOW FILTERING');
    await settle();
    const last = executed().at(-1)!.payload;
    expect(last['sql']).toBe('SELECT * FROM shop.readings WHERE (value > 2) ALLOW FILTERING');
    expect(last['confirm']).toBe(true);
    expect(root().querySelector('.db-data-filtering')).toBeNull();
    expect(root().querySelector('.db-data-chips')?.textContent).toContain('ALLOW FILTERING');
    // Removing it goes back to the plain filter.
    await clickButton(fixture, 'Remove ALLOW FILTERING');
    await settle();
    expect(executed().at(-1)!.payload['sql']).toBe('SELECT * FROM shop.readings WHERE (value > 2)');
  }, 15_000);
});
