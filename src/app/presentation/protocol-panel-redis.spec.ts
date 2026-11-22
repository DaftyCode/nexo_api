import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import { clickButton, fill, renderDeferred } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ProtocolPanel } from './protocol-panel';
import { channelList } from './protocol-panel/watch';
import { WorkspaceState } from './workspace-state';

const connection: WorkspaceDocument = {
  id: 'r1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Cache',
  revision: 1,
  updated_at: 0,
  value: { driver: 'redis', host: '{{host}}', port: 6379, password: '{{vault:redis}}' },
};

describe('ProtocolPanel with Redis subscriptions', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<ProtocolPanel>;
  let api: TestApi;
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
        'db.kv.subscribe': { id: 'redis-sub-1.s1', state: 'connected' },
        'realtime.poll': {
          state: 'connected',
          events: [
            {
              sequence: 1,
              type: 'message',
              data: { channel: 'news', payload: 'hello' },
              time: 0,
            },
          ],
        },
        'realtime.close': { closed: true },
      }),
      imports: [ProtocolPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    const state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.applySaved([connection]);
    fixture = TestBed.createComponent(ProtocolPanel);
    await settle();
    await fill(fixture, 'Protocol', 'redis');
    await settle();
  });

  it('follows channels and patterns of a saved connection and shows each message', async () => {
    expect(root().querySelector('[aria-label="Connection URL"]')).toBeNull();
    expect(root().textContent).not.toContain('Send message');
    // Without a connection chosen, nothing opens.
    await clickButton(fixture, 'Connect');
    await settle();
    expect(calls('db.kv.subscribe')).toHaveLength(0);
    await fill(fixture, 'Connection', 'r1');
    await fill(fixture, 'Channels', 'news, orders');
    await fill(fixture, 'Patterns', 'n*');
    await settle();
    expect(root().textContent).toContain('Cache · news, orders, n*');
    await clickButton(fixture, 'Connect');
    await settle();
    expect(calls('db.kv.subscribe')[0].payload).toMatchObject({
      workspace: 'local',
      connectionId: 'r1',
      channels: ['news', 'orders'],
      patterns: ['n*'],
    });
    await waitPoll();
    await settle();
    expect(calls('realtime.poll')[0].payload).toMatchObject({ id: 'redis-sub-1.s1' });
    expect(root().textContent).toContain('hello');
    await clickButton(fixture, 'Disconnect');
    await settle();
    expect(calls('realtime.close')[0].payload).toMatchObject({ id: 'redis-sub-1.s1' });
  });

  it('reads channels separated by commas or spaces', () => {
    expect(channelList(' news,orders  a.b ')).toEqual(['news', 'orders', 'a.b']);
    expect(channelList('')).toEqual([]);
  });
});
