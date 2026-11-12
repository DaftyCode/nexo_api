import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import { clickButton, fill, renderDeferred } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ProtocolPanel } from './protocol-panel';
import { WorkspaceState } from './workspace-state';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Replica',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://{{host}}:27119/?replicaSet=rs0', password: '{{vault:mongo}}' },
};

describe('ProtocolPanel with MongoDB change streams', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<ProtocolPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);
  const waitPoll = () => new Promise((resolve) => setTimeout(resolve, 400));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.watch': { id: 'mongo-watch-1', state: 'connected' },
        'realtime.poll': {
          state: 'connected',
          events: [
            { sequence: 1, type: 'open', data: { watching: 'shop.orders' }, time: 0 },
            {
              sequence: 2,
              type: 'insert',
              data: { operationType: 'insert', documentKey: { _id: 1 } },
              time: 0,
            },
          ],
        },
        'realtime.close': { closed: true },
      }),
      imports: [ProtocolPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.applySaved([connection]);
    fixture = TestBed.createComponent(ProtocolPanel);
    await settle();
    await fill(fixture, 'Protocol', 'mongodb');
    await settle();
  });

  it('watches a collection of a saved connection and shows each change', async () => {
    expect(root().querySelector('[aria-label="Connection URL"]')).toBeNull();
    expect(root().textContent).toContain('Change streams need a replica set');
    expect(root().textContent).not.toContain('Send message');
    await fill(fixture, 'MongoDB connection', 'c1');
    await fill(fixture, 'Database', 'shop');
    await fill(fixture, 'Collection', 'orders');
    await fill(fixture, 'Pipeline', "[{$match: {operationType: 'insert'}}]");
    await fill(fixture, 'Document after the change', 'updateLookup');
    await settle();
    expect(root().textContent).toContain('Replica · shop.orders');
    await clickButton(fixture, 'Connect');
    await settle();
    const [watch] = calls('mongo.watch');
    expect(watch.payload).toMatchObject({
      database: 'shop',
      collection: 'orders',
      pipeline: [{ $match: { operationType: 'insert' } }],
      fullDocument: 'updateLookup',
      connection: { password: '{{vault:mongo}}' },
    });
    expect(watch.payload).not.toHaveProperty('fullDocumentBeforeChange');
    await waitPoll();
    await settle();
    expect(calls('realtime.poll')[0].payload).toMatchObject({ id: 'mongo-watch-1' });
    expect(root().textContent).toContain('insert');
    expect(root().textContent).toContain('"documentKey"');
    await clickButton(fixture, 'Disconnect');
    await settle();
    expect(calls('realtime.close')[0].payload).toMatchObject({ id: 'mongo-watch-1' });
  });

  it('says why it cannot watch before asking the server', async () => {
    await clickButton(fixture, 'Connect');
    await settle();
    expect(root().textContent).toContain('Choose a saved connection');
    await fill(fixture, 'MongoDB connection', 'c1');
    await fill(fixture, 'Pipeline', '{$match: {}}');
    await clickButton(fixture, 'Connect');
    await settle();
    expect(root().textContent).toContain('The pipeline is an array of stages');
    await fill(fixture, 'Pipeline', '[]');
    await fill(fixture, 'Collection', 'orders');
    await clickButton(fixture, 'Connect');
    await settle();
    expect(root().textContent).toContain('Choose the database of the collection to watch');
    expect(calls('mongo.watch')).toHaveLength(0);
  });
});
