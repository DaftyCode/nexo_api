import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TRANSFER_FILES } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import { SchemaReport } from '../domain/mongo-schema';
import { clickButton, control, exerciseControls, fill, renderDeferred } from '../testing/controls';
import { TestTransferFiles } from '../testing/mongo-transfer';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { MongoExplorer } from './mongo-explorer';
import { WorkspaceState } from './workspace-state';

const connection = (readOnly = false): WorkspaceDocument => ({
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://localhost:27017', ...(readOnly ? { readOnly: true } : {}) },
});

const report: SchemaReport = {
  sampled: 20,
  truncated: false,
  elapsedMs: 7,
  validator: { $jsonSchema: { bsonType: 'object', required: ['city'] } },
  jsonSchema: { type: 'object' },
  fields: [
    {
      path: 'age',
      name: 'age',
      depth: 0,
      count: 19,
      parents: 20,
      types: [
        { name: 'Int32', count: 18, min: { $numberInt: '22' }, max: { $numberInt: '39' } },
        { name: 'String', count: 1, lengths: { min: 3, max: 3, average: 3 } },
      ],
      values: [{ value: { $numberInt: '30' }, count: 4 }],
      distinct: 12,
      distinctCapped: false,
      anomalies: ['mixedTypes', 'sometimesMissing'],
    },
    {
      path: 'address',
      name: 'address',
      depth: 0,
      count: 20,
      parents: 20,
      types: [{ name: 'Document', count: 20 }],
      values: [],
      distinct: 0,
      distinctCapped: false,
      anomalies: [],
    },
    {
      path: 'address.city',
      name: 'city',
      depth: 1,
      count: 20,
      parents: 20,
      types: [{ name: 'String', count: 20 }],
      values: [{ value: 'Lugo', count: 15 }],
      distinct: 2,
      distinctCapped: false,
      anomalies: [],
    },
  ],
};

describe('MongoSchema', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<MongoExplorer>;
  let api: TestApi;
  let files: TestTransferFiles;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const tab = () => root().querySelector<HTMLElement>('app-mongo-schema')!;
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp, within: Element = root()) => {
    await clickButton(fixture, label, within);
    await settle();
  };
  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);

  async function open(readOnly = false) {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.databases': { databases: [{ name: 'shop', sizeOnDisk: 2048, empty: false }] },
        'mongo.collections': {
          collections: [{ name: 'people', kind: 'collection', capped: false }],
        },
        'mongo.stats': {
          count: 20,
          size: 300,
          storageSize: 300,
          totalIndexSize: 0,
          indexes: [],
          capped: false,
        },
        'mongo.find': {
          documents: [{ _id: 1, nick: { first: 'A' } }],
          elapsedMs: 1,
        },
        'mongo.schema': report,
        'mongo.collection.validator': { done: true },
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    files = TestBed.inject(TRANSFER_FILES) as TestTransferFiles;
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection(readOnly));
    await settle();
    await click('shop');
    await click(/^people/);
    await click(/^Schema$/);
  }

  it('shows the fields of a sample with their anomalies, and opens a value', async () => {
    await open();
    await fill(fixture, 'Documents sampled', '5000', tab());
    await click(/^Analyze$/, tab());
    expect(calls('mongo.schema')[0].payload).toMatchObject({
      database: 'shop',
      collection: 'people',
      size: 5000,
    });
    expect(calls('mongo.schema')[0].payload).not.toHaveProperty('filter');
    const text = tab().textContent ?? '';
    expect(text).toContain('20 documents sampled · 7 ms');
    expect(text).toContain('values of 2 types, mostly Int32.');
    expect(text).toContain('missing in 1 of 20.');
    expect(text).toMatch(/95%\s*\(19\/20\)/);
    expect(text).toContain('Int32 94.7%');

    await click(/^\s*age/, tab().querySelector('table')!);
    expect(tab().textContent).toContain('Int32: from NumberInt(22) to NumberInt(39)');
    expect(tab().textContent).toContain('String length: from 3 to 3, 3 on average');
    await click(/^\s*city/, tab().querySelector('table')!);
    await click('Find the documents with "Lugo"', tab());
    expect(fixture.componentInstance.tab()).toBe('documents');
    expect(fixture.componentInstance.model().filter).toBe('{ "address.city": "Lugo" }');
    expect(calls('mongo.find').at(-1)?.payload).toMatchObject({
      filter: { 'address.city': 'Lugo' },
    });
    // The schema's fields and the page's are suggested in the query.
    expect(fixture.componentInstance.fieldNames()).toEqual([
      'age',
      'address',
      'address.city',
      '_id',
      'nick',
      'nick.first',
    ]);
  });

  it('samples the documents of the query, and exports the schema', async () => {
    await open();
    fixture.componentInstance.model.update((model) => ({ ...model, filter: "{city: 'Lugo'}" }));
    (control(tab(), 'Only the documents of the query') as HTMLInputElement).click();
    await settle();
    await click(/^Analyze$/, tab());
    expect(calls('mongo.schema')[0].payload).toMatchObject({ filter: { city: 'Lugo' } });

    await click(/^CSV$/, tab());
    await click(/^\$jsonSchema$/, tab());
    const [csv, validator] = files.targets;
    expect(csv.name).toBe('people-schema.csv');
    expect(csv.text.split('\n')[1]).toContain('age,95,');
    expect(validator.name).toBe('people-validator.json');
    expect(JSON.parse(validator.text)).toEqual(report.validator);
  });

  it('applies the validation rules only once the collection is named', async () => {
    await open();
    await click(/^Analyze$/, tab());
    await click('Apply the rules', tab());
    expect(tab().textContent).toContain('Type the name of the collection to replace its rules');
    expect(calls('mongo.collection.validator')).toHaveLength(0);
    await fill(fixture, 'Validation action', 'warn', tab());
    await fill(fixture, 'Type people to confirm', 'people', tab());
    await click('Apply the rules', tab());
    expect(calls('mongo.collection.validator')[0].payload).toMatchObject({
      connectionId: 'c1',
      database: 'shop',
      collection: 'people',
      validator: report.validator,
      validationLevel: 'strict',
      validationAction: 'warn',
      confirm: 'people',
    });
    expect(tab().textContent).toContain('Validation rules applied');
  });

  it('only shows the rules on a read-only connection', async () => {
    await open(true);
    await click(/^Analyze$/, tab());
    expect(tab().textContent).toContain('Validation rules');
    expect(tab().textContent).not.toContain('Apply the rules');
  });

  it('keeps every setting typed in the tab', async () => {
    await open();
    await click(/^Analyze$/, tab());
    const schema = fixture.componentInstance.schema;
    const unchanged = await exerciseControls(fixture, () => schema.model(), { root: tab() });
    expect(unchanged).toEqual([]);
  });
});
