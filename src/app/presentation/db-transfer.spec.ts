import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton } from '../testing/controls';
import { TRANSFER_FILES } from '../composition/providers';
import { TestTransferFiles, sourceFile } from '../testing/mongo-transfer';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from './db-panel';
import { DbSection } from './db-panel/section';
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

describe('the data transfer wizard', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  let files: TestTransferFiles;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 12; i++) await fixture.whenStable();
  };
  const calls = (operation: string) =>
    api.calls.filter((call) => call.operation === operation).map((call) => call.payload);
  const dialog = () => root().querySelector<HTMLElement>('[role="dialog"]')!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '18', database: 'shop', tls: false }),
        'db.transaction': () => ({ autoCommit: true, open: false }),
        'db.disconnect': () => undefined,
        'db.execute': (payload: Record<string, unknown>) =>
          /WHERE 1 = 0/.test(String(payload['sql']))
            ? {
                columns: [
                  { name: 'id', typeName: 'int4', kind: 'integer' },
                  { name: 'label', typeName: 'text', kind: 'text' },
                ],
                rows: [],
                elapsedMs: 1,
              }
            : {
                columns: [
                  { name: 'id', typeName: 'int4', kind: 'integer' },
                  { name: 'label', typeName: 'text', kind: 'text' },
                ],
                rows: [
                  [1, 'lamp'],
                  [2, null],
                ],
                cursor: 'k1',
                elapsedMs: 1,
              },
        'db.fetch': () => ({ rows: [[3, 'desk, big']], cursor: null }),
        'db.import': (payload: Record<string, unknown>) => ({
          inserted: (payload['rows'] as unknown[]).length - 1,
          upserted: 0,
          failed: 1,
          failures: [{ position: 2, message: 'invalid input syntax for type integer: "x"' }],
        }),
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    files = TestBed.inject(TRANSFER_FILES) as TestTransferFiles;
    const state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push(connection);
    await state.refresh();
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  });

  function open(kind: 'export' | 'import') {
    const section = fixture.debugElement.injector.get(DbSection);
    section.transferRequest.set({
      kind,
      connection: 'c1',
      sql: 'SELECT * FROM "items"',
      name: 'items',
      table: { schema: 'public', name: 'items', qualified: '"items"' },
    });
  }

  it('exports every page of the table to the file chosen', async () => {
    open('export');
    await settle();
    expect(dialog().textContent).toContain('items.csv');
    await clickButton(fixture, 'Export');
    await settle();
    expect(files.targets[0].name).toBe('items.csv');
    expect(files.targets[0].text).toBe('id,label\n1,lamp\n2,\n3,"desk, big"\n');
    expect(dialog().textContent).toContain('3 rows exported.');
    // The wizard's session is closed at the end.
    expect(calls('db.disconnect')).toHaveLength(1);
  });

  it('imports a CSV into the table and says the rows that failed', async () => {
    files.sources.push(sourceFile('more.csv', 'id,label\n4,chair\nx,stool\n'));
    open('import');
    await settle();
    await clickButton(fixture, 'Choose a file');
    await settle();
    const target = dialog().querySelector<HTMLSelectElement>('[aria-label="Where id goes"]')!;
    expect(target.value).toBe('id');
    buttons(dialog(), 'Import')[0].click();
    await settle();
    const [batch] = calls('db.import');
    expect(batch['columns']).toEqual(['id', 'label']);
    expect(batch['rows']).toEqual([
      [4, 'chair'],
      ['x', 'stool'],
    ]);
    expect(batch['stopOnError']).toBe(true);
    expect(calls('db.transaction').map((call) => call['action'])).toEqual(
      expect.arrayContaining(['begin', 'commit']),
    );
    expect(dialog().textContent).toContain('Row 2:');
    expect(dialog().textContent).toContain('invalid input syntax');
  });
});
