import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TRANSFER_FILES } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import { clickButton, control, exerciseControls, fill, renderDeferred } from '../testing/controls';
import { TestTransferFiles, sourceFile } from '../testing/mongo-transfer';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { MongoExplorer } from './mongo-explorer';
import { WorkspaceState } from './workspace-state';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://localhost:27017' },
};

const order = (n: number) => ({
  _id: { $oid: `65a1b2c3d4e5f6a7b8c9d0e${n}` },
  n: { $numberInt: String(n) },
  customer: { name: `C${n}`, city: 'Lugo, "centro"' },
});

describe('MongoTransfer', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<MongoExplorer>;
  let api: TestApi;
  let files: TestTransferFiles;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const dialog = () => root().querySelector<HTMLElement>('app-mongo-transfer [role="dialog"]')!;
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp, within: Element = root()) => {
    await clickButton(fixture, label, within);
    await settle();
  };
  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.databases': { databases: [{ name: 'shop', sizeOnDisk: 2048, empty: false }] },
        'mongo.collections': {
          collections: [{ name: 'orders', kind: 'collection', capped: false }],
        },
        'mongo.stats': {
          count: 3,
          size: 300,
          storageSize: 300,
          averageDocumentSize: 100,
          totalIndexSize: 0,
          indexes: [],
          capped: false,
        },
        'mongo.find': { documents: [order(1), order(2)], cursor: 'c-1', elapsedMs: 4 },
        'mongo.more': { documents: [order(3)], elapsedMs: 2 },
        'mongo.import': (payload: Record<string, unknown>) => ({
          inserted: (payload['documents'] as unknown[]).length,
          upserted: 0,
          replaced: 0,
          cleared: payload['clearConfirm'] === undefined ? 0 : 9,
          failed: [],
        }),
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    files = TestBed.inject(TRANSFER_FILES) as TestTransferFiles;
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection);
    await settle();
    await click('shop');
    await click(/^orders/);
  });

  it('exports a query to CSV with the fields chosen, in their order', async () => {
    await fill(fixture, 'Filter', '{n: {$gt: 0}}');
    await click('Export…');
    expect(dialog().textContent).toContain('filter: {n: {$gt: 0}}');
    await fill(fixture, 'Format', 'csv', dialog());
    await settle();
    // The fields of the first documents become the columns.
    expect(dialog().textContent).toContain('customer.city');
    await click('Move customer.name up', dialog());
    (control(dialog(), '_id') as HTMLInputElement).click();
    await settle();
    await click(/^Export$/, dialog());

    const [file] = files.targets;
    expect(file.name).toMatch(/^orders-\d{4}-\d\d-\d\d\.csv$/);
    expect(file.state).toBe('closed');
    const city = '"Lugo, ""centro"""';
    expect(file.text).toBe(
      `customer.name,n,customer.city\nC1,1,${city}\nC2,2,${city}\nC3,3,${city}\n`,
    );
    expect(calls('mongo.find').at(-1)?.payload).toMatchObject({
      database: 'shop',
      collection: 'orders',
      filter: { n: expect.anything() },
      pageSize: 1000,
    });
    expect(dialog().textContent).toMatch(/Read\s*3/);
    await click(/^Close$/, dialog());
    expect(root().querySelector('app-mongo-transfer')).toBeNull();
  });

  it('imports a CSV with typed columns and lists the rows that failed', async () => {
    files.sources.push(sourceFile('people.csv', 'name,age,notes\nAna,41,x\nLuis,old,y\nEva,7,z\n'));
    await click('Import…');
    await click('Choose a file', dialog());
    expect(dialog().textContent).toContain('people.csv');
    expect(dialog().textContent).toContain('41 · old · 7');
    await fill(fixture, 'Type of the column age', 'int', dialog());
    await fill(fixture, 'Type of the column notes', 'skip', dialog());
    await fill(fixture, 'Field of the column name', 'person.name', dialog());
    await click(/^Import$/, dialog());

    const [batch] = calls('mongo.import');
    expect(batch.payload).toMatchObject({
      database: 'shop',
      collection: 'orders',
      connectionId: 'c1',
      mode: 'insert',
      ordered: false,
      documents: [
        { person: { name: 'Ana' }, age: { $numberInt: '41' } },
        { person: { name: 'Eva' }, age: { $numberInt: '7' } },
      ],
    });
    const shown = dialog().textContent ?? '';
    expect(shown).toMatch(/Inserted\s*2/);
    expect(shown).toMatch(/Failed\s*1/);
    expect(shown).toMatch(/Document 2:\s*the column age is not a valid Number value\./);
    // The collection shown is read again.
    expect(calls('mongo.find').length).toBeGreaterThan(1);
  });

  it('empties the collection only after its name is typed, and saves the transfer', async () => {
    files.sources.push(sourceFile('orders.jsonl', '{"a":1}\n{"a":2}\n'));
    await click('Import…');
    await click('Choose a file', dialog());
    await fill(fixture, 'Mode', 'replace', dialog());
    await click(/^Import$/, dialog());
    expect(dialog().textContent).toContain('Type the name of the collection to empty it');
    expect(calls('mongo.import')).toHaveLength(0);
    await fill(fixture, 'Type orders to confirm', 'orders', dialog());
    await fill(fixture, 'Transfer name', 'Reload orders', dialog());
    await click('Save transfer', dialog());
    await click(/^Import$/, dialog());
    expect(calls('mongo.import')[0].payload).toMatchObject({
      clearConfirm: 'orders',
      documents: [{ a: 1 }, { a: 2 }],
    });
    expect(dialog().textContent).toMatch(/Removed first\s*9/);
    await click(/^Close$/, dialog());

    // The saved transfer opens again from the sidebar, without the confirmation.
    const saved = api.documentsStore.find((d) => d.kind === 'mongo-transfer')!;
    expect(saved.name).toBe('Reload orders');
    expect(saved.value).toMatchObject({ direction: 'import', mode: 'replace', format: 'jsonl' });
    await click(/^Reload orders$/);
    expect((control(dialog(), 'Mode') as HTMLSelectElement).value).toBe('replace');
    expect((control(dialog(), 'Type orders to confirm') as HTMLInputElement).value).toBe('');
    await click(/^Cancel$/, dialog());
    state.confirm = () => true;
    await click('Delete the transfer Reload orders');
    expect(api.documentsStore.some((d) => d.kind === 'mongo-transfer')).toBe(false);
  });

  it('keeps every setting typed in the dialog', async () => {
    state.applySaved([connection, { ...connection, id: 'c2', name: 'Copy' }]);
    await click('Export…');
    const draft = fixture.componentInstance.transfers.draft()!;
    const read = () => [draft.model(), draft.chosen()];
    const unchanged = await exerciseControls(fixture, read, { root: dialog() });
    expect(unchanged).toEqual([]);
  });
});
