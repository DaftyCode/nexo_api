import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import {
  clickButton,
  codeEditor,
  codeText,
  control,
  exerciseControls,
  fill,
  renderDeferred,
  typeCode,
} from '../testing/controls';
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

const operators = (payload: Record<string, unknown>) =>
  (payload['pipeline'] as Record<string, unknown>[]).map((stage) => Object.keys(stage)[0]);

describe('MongoAggregations', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<MongoExplorer>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const tab = () => root().querySelector<HTMLElement>('app-mongo-aggregations')!;
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp, within: Element = root()) => {
    await clickButton(fixture, label, within);
    await settle();
  };
  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);
  const typeStage = async (label: string, text: string) => {
    typeCode(codeEditor(tab(), `Value of stage ${label}`), text);
    await settle();
  };

  async function open(readOnly = false) {
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
          totalIndexSize: 0,
          indexes: [],
          capped: false,
        },
        'mongo.find': { documents: [], elapsedMs: 1 },
        'mongo.aggregate': (payload: Record<string, unknown>) => ({
          documents: [{ _id: 'Lugo', n: { $numberInt: String(operators(payload).length) } }],
          ...(payload['pageSize'] === 50 ? { cursor: 'agg-1' } : {}),
          elapsedMs: 3,
        }),
        'mongo.more': { documents: [{ _id: 'Vigo', n: 1 }], elapsedMs: 2 },
        'mongo.aggregate.write': { database: 'shop', collection: 'summary', elapsedMs: 9 },
        'mongo.explain': { explain: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } } },
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection(readOnly));
    await settle();
    await click('shop');
    await click(/^orders/);
    await click(/^Aggregations$/);
  }

  it('previews each stage without the one that writes, and with a limit at the end', async () => {
    await open();
    await typeStage('1 $match', "{status: 'A'}");
    await fill(fixture, 'New stage', '$lookup', tab());
    await click('Add stage', tab());
    await typeStage(
      '2 $lookup',
      "{from: 'customers', localField: 'customer', foreignField: '_id', as: 'c'}",
    );
    await fill(fixture, 'New stage', '$out', tab());
    await click('Add stage', tab());
    expect(tab().textContent).toContain('Writes data');

    await click('Preview every stage', tab());
    const previews = calls('mongo.aggregate').map((call) => call.payload);
    expect(previews.map(operators)).toEqual([
      ['$match', '$limit'],
      ['$match', '$lookup', '$limit'],
    ]);
    expect(previews[1]).toMatchObject({
      database: 'shop',
      collection: 'orders',
      pipeline: [{ $match: { status: 'A' } }, expect.anything(), { $limit: 10 }],
      pageSize: 10,
    });
    expect(tab().textContent).toContain('The first 1 documents after this stage');
    expect(tab().textContent).toContain('This stage writes: a preview never runs it.');

    // A stage turned off is not in the preview of the next one.
    (control(tab(), 'Run this stage') as HTMLInputElement).click();
    await settle();
    await click('Preview stage 2 $lookup', tab());
    expect(operators(calls('mongo.aggregate').at(-1)!.payload)).toEqual(['$lookup', '$limit']);
  });

  it('runs the pipeline with its pages, and explains it without the stage that writes', async () => {
    await open();
    await typeStage('1 $match', '{n: {$gt: 1}}');
    await fill(fixture, 'New stage', '$group', tab());
    await click('Add stage', tab());
    await click(/^Run$/, tab());
    expect(calls('mongo.aggregate')[0].payload).toMatchObject({
      pipeline: [{ $match: { n: { $gt: 1 } } }, { $group: expect.anything() }],
      pageSize: 50,
    });
    expect(tab().querySelector('[data-testid="aggregation-range"]')?.textContent).toContain('1');
    // Only the fields the engine reads: it refuses any other.
    expect(calls('mongo.aggregate')[0].payload).not.toHaveProperty('kind');
    await click('Next page', tab());
    expect(calls('mongo.more')[0].payload).toMatchObject({ cursor: 'agg-1', pageSize: 50 });

    await fill(fixture, 'Collation', "{locale: 'es'}", tab());
    await click(/^Explain$/, tab());
    expect(calls('mongo.explain')[0].payload).toMatchObject({
      pipeline: [{ $match: expect.anything() }, { $group: expect.anything() }],
      collation: { locale: 'es' },
    });
    expect(fixture.componentInstance.tab()).toBe('explain');
    expect(calls('mongo.explain')[0].payload).not.toHaveProperty('kind');
  });

  it('writes with $out only after the collection is named again', async () => {
    await open();
    await fill(fixture, 'New stage', '$out', tab());
    await click('Add stage', tab());
    await typeStage('2 $out', "'summary'");
    await click('Run and write', tab());
    expect(tab().textContent).toContain('Type the name of the collection the pipeline writes');
    expect(calls('mongo.aggregate.write')).toHaveLength(0);
    await fill(fixture, 'Type summary to confirm', 'summary', tab());
    await click('Run and write', tab());
    expect(calls('mongo.aggregate.write')[0].payload).toMatchObject({
      connectionId: 'c1',
      confirm: 'summary',
      pipeline: [{ $match: expect.anything() }, { $out: 'summary' }],
    });
    expect(calls('mongo.aggregate.write')[0].payload).not.toHaveProperty('kind');
    expect(tab().textContent).toContain('Written to shop.summary in 9 ms.');
  });

  it('does not run a pipeline that writes on a read-only connection', async () => {
    await open(true);
    await fill(fixture, 'New stage', '$merge', tab());
    await click('Add stage', tab());
    expect(tab().textContent).toContain('This connection is read-only');
    const run = [...tab().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Run and write'),
    )!;
    expect(run.disabled).toBe(true);
  });

  it('pastes a pipeline as text, saves it and opens it again', async () => {
    await open();
    await click('Pipeline as text', tab());
    typeCode(codeEditor(tab(), 'Pipeline as text'), '[{$match: {a: 1}}, {"$limit": 5}, 7]');
    await settle();
    await click('Use this pipeline', tab());
    expect(tab().textContent).toContain('Stage 3 is not a document with one operator');
    typeCode(codeEditor(tab(), 'Pipeline as text'), "[{$match: {a: 1}}, {$sortByCount: '$b'}]");
    await settle();
    await click('Use this pipeline', tab());
    expect(codeText(tab(), 'Value of stage 2 $sortByCount')).toBe('"$b"');

    await fill(fixture, 'Pipeline name', 'By b', tab());
    await click('Save pipeline', tab());
    const saved = api.documentsStore.find((d) => d.kind === 'mongo-aggregation')!;
    expect(saved).toMatchObject({
      name: 'By b',
      value: { database: 'shop', collection: 'orders' },
    });
    await click('Clear', tab());
    expect(tab().querySelectorAll('app-mongo-aggregation-stage')).toHaveLength(1);
    await click(/^By b$/);
    expect(codeText(tab(), 'Value of stage 1 $match')).toContain('a: 1');
    state.confirm = () => true;
    await click('Delete the aggregation By b');
    expect(api.documentsStore.some((d) => d.kind === 'mongo-aggregation')).toBe(false);
  });

  it('exports the results of the pipeline with the dialog of exports', async () => {
    await open();
    await click('Export…', tab());
    const dialog = root().querySelector<HTMLElement>('app-mongo-transfer [role="dialog"]')!;
    expect((control(dialog, 'Documents') as HTMLSelectElement).value).toBe('aggregation');
    expect(dialog.querySelector('pre')?.textContent).toContain("$match: {\n      status: 'A'");
  });

  it('keeps every setting typed in the tab', async () => {
    await open();
    const editor = fixture.componentInstance.aggregations;
    const unchanged = await exerciseControls(fixture, () => editor.model(), {
      root: tab(),
      skip: (element) => element.closest('.mongo-pipeline-text') !== null,
    });
    expect(unchanged).toEqual([]);
  });
});
