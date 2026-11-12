import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import { clickButton, fill, renderDeferred } from '../testing/controls';
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
const result = {
  key: 'sku',
  counts: { onlySource: 1, onlyTarget: 1, different: 1, equal: 7, withoutKey: 2 },
  differences: [
    { kind: 'onlySource', key: 'a-1' },
    { kind: 'onlyTarget', key: 'z-9' },
    {
      kind: 'different',
      key: 'b-2',
      fields: [{ path: 'price', source: 10, target: 12 }],
    },
  ],
  truncated: false,
  elapsedMs: 4,
};

describe('MongoDB comparison of two collections', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<MongoExplorer>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const dialog = () => root().querySelector<HTMLElement>('app-mongo-compare [role="dialog"]')!;
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
          collections: [{ name: 'products', kind: 'collection', capped: false }],
        },
        'mongo.stats': {
          count: 10,
          size: 3,
          storageSize: 3,
          totalIndexSize: 0,
          indexes: [],
          capped: false,
        },
        'mongo.find': { documents: [], elapsedMs: 1 },
        'mongo.compare': result,
        'mongo.sync': { inserted: 1, replaced: 1, deleted: 1 },
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.applySaved([connection]);
    state.confirm = () => true;
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection);
    await settle();
    await click('shop');
    await click(/^products/);
  });

  it('compares by a key, shows the fields that differ and syncs the other collection', async () => {
    await click('Compare…');
    expect(dialog().textContent).toContain('Compare products with');
    await click(/^Compare$/, dialog());
    expect(dialog().textContent).toContain('Choose the collection to compare with');
    expect(calls('mongo.compare')).toHaveLength(0);

    await fill(fixture, 'Collection', 'products_copy', dialog());
    await fill(fixture, 'Filter of both', "{ status: 'A' }", dialog());
    await fill(fixture, 'Key', 'sku', dialog());
    await fill(fixture, 'Fields left out', 'updatedAt, meta.at', dialog());
    await click(/^Compare$/, dialog());
    expect(calls('mongo.compare')[0].payload).toMatchObject({
      source: { database: 'shop', collection: 'products' },
      target: { database: 'shop', collection: 'products_copy' },
      filter: { status: 'A' },
      key: 'sku',
      ignore: ['updatedAt', 'meta.at'],
    });
    const text = () => dialog().textContent ?? '';
    expect(text()).toContain('Only in this collection · 1');
    expect(text()).toContain('7 equal · 4 ms');
    expect(text()).toContain('2 documents without sku cannot be paired.');

    // Only the differing ones, then the fields of one side by side.
    await click(/^Different · 1/, dialog());
    expect(dialog().querySelectorAll('ul[aria-label="Differences"] li')).toHaveLength(1);
    await click('sku: "b-2"', dialog());
    const cells = [
      ...dialog().querySelectorAll('table[aria-label="Fields that differ"] tbody tr > *'),
    ].map((cell) => cell.textContent?.trim());
    expect(cells).toEqual(['price', '10', '12']);

    // The sync says what it writes and asks for the target name.
    expect(text()).toContain('It inserts 1, replaces 1 and deletes 0 documents');
    const remove = dialog().querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!;
    remove.click();
    await settle();
    expect(text()).toContain('It inserts 1, replaces 1 and deletes 1 documents');
    await click(/^Sync$/, dialog());
    expect(text()).toContain('Type the name of the target collection to sync it');
    expect(calls('mongo.sync')).toHaveLength(0);
    await fill(fixture, 'Type products_copy to confirm', 'products_copy', dialog());
    await click(/^Sync$/, dialog());
    expect(calls('mongo.sync')[0].payload).toMatchObject({
      database: 'shop',
      collection: 'products_copy',
      source: { collection: 'products' },
      key: 'sku',
      remove: true,
      confirm: 'products_copy',
    });
    expect(text()).toContain('Synced: 1 inserted, 1 replaced, 1 deleted.');
    // It compares again after the sync.
    expect(calls('mongo.compare')).toHaveLength(2);
  });

  it('saves a comparison, opens it again from the sidebar and deletes it', async () => {
    await click('Compare…');
    await fill(fixture, 'Collection', 'products_copy', dialog());
    await fill(fixture, 'Key', 'sku', dialog());
    await click('Save comparison', dialog());
    const saved = api.documentsStore.find((d) => d.kind === 'mongo-compare')!;
    expect(saved).toMatchObject({
      name: 'products ↔ products_copy',
      value: {
        connection: 'c1',
        database: 'shop',
        collection: 'products',
        target: { connection: 'c1', database: 'shop', collection: 'products_copy' },
        key: 'sku',
      },
    });
    await click(/^Close$/, dialog());
    expect(root().querySelector('app-mongo-compare')).toBeNull();

    await click('products ↔ products_copy');
    expect(
      dialog().querySelector<HTMLInputElement>('input[spellcheck][placeholder="_id"]')?.value,
    ).toBe('sku');
    await click(/^Close$/, dialog());
    await click('Delete the comparison products ↔ products_copy');
    expect(api.documentsStore.some((d) => d.kind === 'mongo-compare')).toBe(false);
    expect(root().textContent).toContain('Save a comparison to run it again.');
  });
});
