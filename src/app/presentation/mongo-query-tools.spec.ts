import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import { TRANSFER_FILES } from '../composition/providers';
import {
  clickButton,
  codeEditor,
  codeText,
  control,
  fill,
  renderDeferred,
  typeCode,
} from '../testing/controls';
import { TestTransferFiles } from '../testing/mongo-transfer';
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

describe('MongoDB query tools: code, SQL and filter blocks', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<MongoExplorer>;
  let api: TestApi;
  let files: TestTransferFiles;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp, within: Element = root()) => {
    await clickButton(fixture, label, within);
    await settle();
  };
  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);
  const explorer = () => fixture.componentInstance;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.databases': { databases: [{ name: 'shop', sizeOnDisk: 2048, empty: false }] },
        'mongo.collections': {
          collections: [
            { name: 'orders', kind: 'collection', capped: false },
            { name: 'people', kind: 'collection', capped: false },
          ],
        },
        'mongo.stats': {
          count: 3,
          size: 3,
          storageSize: 3,
          totalIndexSize: 0,
          indexes: [],
          capped: false,
        },
        'mongo.find': { documents: [{ _id: 1, status: 'A', qty: 5 }], elapsedMs: 1 },
        'mongo.aggregate': { documents: [{ _id: 'A', n: 2 }], elapsedMs: 1 },
        'mongo.sql': (payload: Record<string, unknown>) =>
          String(payload['sql']).includes('GROUP BY')
            ? {
                kind: 'aggregate',
                collection: 'people',
                pipeline: [{ $group: { _id: '$city', n: { $sum: 1 } } }],
              }
            : {
                kind: 'find',
                collection: 'people',
                filter: { age: { $gte: 18 } },
                sort: { age: -1 },
                limit: 5,
              },
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    files = TestBed.inject(TRANSFER_FILES) as TestTransferFiles;
    const state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection);
    await settle();
    await click('shop');
    await click(/^orders/);
  });

  it('writes the driver code of the query in each language, to copy or download', async () => {
    await fill(fixture, 'Filter', "{ status: 'A', at: ISODate('2024-01-02T00:00:00Z') }");
    await click(/^Code$/);
    const dialog = root().querySelector<HTMLElement>('app-mongo-code [role="dialog"]')!;
    expect(codeText(dialog, 'Code')).toContain('db.getSiblingDB("shop").getCollection("orders")');
    expect(codeText(dialog, 'Code')).toContain('ISODate("2024-01-02T00:00:00.000Z")');
    await fill(fixture, 'Language', 'python', dialog);
    await settle();
    expect(codeText(dialog, 'Code')).toContain('os.environ["MONGODB_URI"]');
    expect(codeText(dialog, 'Code')).not.toContain('localhost');
    await click(/^Download$/, dialog);
    expect(files.targets[0].name).toBe('query.py');
    expect(files.targets[0].text).toContain('collection.find(');
    await click(/^Close$/, dialog);
    expect(root().querySelector('app-mongo-code')).toBeNull();
  });

  it('translates SQL and opens the query it gives, editable, where it runs', async () => {
    await click(/^SQL$/);
    typeCode(
      codeEditor(root(), 'SQL'),
      'SELECT * FROM people WHERE age >= 18 ORDER BY age DESC LIMIT 5',
    );
    await settle();
    await click(/^Translate$/);
    expect(calls('mongo.sql')[0].payload).toMatchObject({
      sql: expect.stringContaining('FROM people'),
    });
    expect(codeText(root(), 'MongoDB query')).toBe(
      'db.people.find({\n  age: {\n    $gte: 18\n  }\n}).sort({\n  age: -1\n}).limit(5)',
    );
    await click('Run in Documents');
    expect(explorer().tab()).toBe('documents');
    expect(explorer().target()?.collection).toBe('people');
    expect(explorer().model()).toMatchObject({
      filter: '{\n  age: {\n    $gte: 18\n  }\n}',
      limit: '5',
    });
    expect(calls('mongo.find').at(-1)?.payload).toMatchObject({ collection: 'people', limit: 5 });

    await click(/^SQL$/);
    typeCode(codeEditor(root(), 'SQL'), 'SELECT city, COUNT(*) FROM people GROUP BY city');
    await settle();
    await click(/^Translate$/);
    await click('Run in Aggregations');
    expect(explorer().tab()).toBe('aggregations');
    expect(explorer().aggregations.model().stages[0].operator).toBe('$group');
    expect(calls('mongo.aggregate').at(-1)?.payload).toMatchObject({
      pipeline: [{ $group: expect.anything() }],
    });
  });

  it('builds the filter with blocks and shows a filter typed by hand as blocks', async () => {
    await fill(fixture, 'Filter', "{ status: 'A', qty: { $gt: 1 } }");
    await click(/^Blocks$/);
    const blocks = () => root().querySelector<HTMLElement>('app-mongo-filter-blocks')!;
    const fields = () =>
      [...blocks().querySelectorAll<HTMLInputElement>('input[aria-label="Field"]')].map(
        (i) => i.value,
      );
    expect(fields()).toEqual(['status', 'qty']);
    await click('Add condition', blocks());
    const last = <T extends Element>(selector: string) =>
      [...blocks().querySelectorAll<T>(selector)].at(-1)!;
    const set = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
      element.value = value;
      element.dispatchEvent(new Event('change'));
      await settle();
    };
    await set(last<HTMLInputElement>('input[aria-label="Field"]'), 'tags');
    await set(last<HTMLSelectElement>('select[aria-label="Operator"]'), '$in');
    await set(last<HTMLInputElement>('input[aria-label="Value"]'), "['x', 'y']");
    expect(explorer().model().filter).toContain('tags: {\n    $in: [');
    // A value that cannot be read leaves the filter as it was and says why.
    await set(last<HTMLInputElement>('input[aria-label="Value"]'), '5');
    expect(root().textContent).toContain('is one of and is none of take a list');
    // A filter the blocks cannot show.
    await fill(fixture, 'Filter', '{ $expr: { $gt: ["$a", "$b"] } }');
    await settle();
    expect(root().textContent).toContain('The blocks cannot show this filter');
    await click('Start from an empty filter');
    expect(explorer().model().filter).toBe('');
    expect(control(blocks(), 'Documents where')).toBeTruthy();
  });
});
