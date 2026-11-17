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
const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Shop',
  revision: 1,
  updated_at: 0,
  value: { driver: 'postgres', host: 'db', database: 'shop' },
};

function split(payload: Record<string, unknown>) {
  const text = String(payload['script']).trim();
  const kind = /^select/i.test(text) ? 'read' : 'write';
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

describe('the execution plan of a statement', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 12; i++) await fixture.whenStable();
  };
  const asked = () =>
    api.calls.filter((call) => call.operation === 'db.explain').map((call) => call.payload);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '18', database: 'shop', tls: false }),
        'db.transaction': () => ({ autoCommit: true, open: false }),
        'db.dialect': () => ({
          driver: { id: 'postgres', name: 'PostgreSQL', version: '1' },
          capabilities: { transactions: true, explain: ['estimated', 'actual'] },
          dialect: { name: 'postgresql', quoteOpen: '"', quoteClose: '"', parameters: 'numbered' },
        }),
        'db.split': split,
        'db.explain': (payload: Record<string, unknown>) => ({
          mode: payload['mode'],
          format: 'json',
          original: '[{"Plan": {}}]',
          ...(payload['mode'] === 'actual' ? { totalMs: 3.5, rolledBack: true } : {}),
          nodes: [
            {
              operation: 'Update',
              object: 'orders',
              estimatedCost: 120,
              ...(payload['mode'] === 'actual' ? { actualMs: 3, actualRows: 0 } : {}),
              children: [
                {
                  operation: 'Seq Scan',
                  object: 'orders',
                  condition: '(total > 10)',
                  estimatedRows: 50_000,
                  estimatedCost: 100,
                  flags: ['full-scan'],
                },
              ],
            },
          ],
        }),
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
      tabs: [],
      activeTab: '',
      drafts: {},
    });
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  });

  it('shows the tree with its warning, then measures a change once confirmed', async () => {
    await clickButton(fixture, 'New SQL script');
    await settle();
    typeCode(
      root().querySelector('.cm-content[aria-label="SQL script"]')!,
      'UPDATE orders SET paid = true WHERE total > 10',
    );
    await settle();
    await clickButton(fixture, 'Explain');
    await settle();
    expect(asked()[0]).toEqual(
      expect.objectContaining({
        mode: 'estimated',
        sql: 'UPDATE orders SET paid = true WHERE total > 10',
      }),
    );
    const tab = root().querySelector('[aria-label="Results"] [role="tab"][aria-selected="true"]');
    expect(tab?.textContent).toContain('Plan ·');
    const plan = root().querySelector<HTMLElement>('app-db-plan')!;
    expect(plan.textContent).toContain('Estimated plan');
    expect(plan.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(plan.querySelector('.db-plan-warnings')?.textContent).toContain('orders is read whole');

    // Collapsing the top node hides what it holds.
    buttons(plan, 'Show or hide what Update holds')[0].click();
    await settle();
    expect(plan.querySelectorAll('tbody tr')).toHaveLength(1);

    await clickButton(fixture, 'Run it to measure');
    await settle();
    const confirm = root().querySelector<HTMLElement>('[role="dialog"]')!;
    expect(confirm.textContent).toContain('rolled back at the end');
    buttons(confirm, 'Run')[0].click();
    await settle();
    expect(asked()[1]).toEqual(expect.objectContaining({ mode: 'actual', confirm: true }));
    const measured = root().querySelector<HTMLElement>('app-db-plan')!;
    expect(measured.textContent).toContain('Actual plan');
    expect(measured.textContent).toContain('Rolled back');
    expect(measured.textContent).toMatch(/3[.,]5 ms in all/);
    // The same tab holds the new plan.
    expect(root().querySelectorAll('[aria-label="Results"] [role="tab"]')).toHaveLength(2);
  });
});
