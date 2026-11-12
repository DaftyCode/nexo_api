import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, exerciseControls } from '../testing/controls';
import { newRequest } from '../domain/models';
import { ProtocolPanel } from './protocol-panel';
import { WorkspaceState } from './workspace-state';

describe('ProtocolPanel', () => {
  let component: ProtocolPanel;

  let fixture: ComponentFixture<ProtocolPanel>;

  let api: TestApi;

  let state: WorkspaceState;

  const root = () => fixture.nativeElement as HTMLElement;

  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };

  const protocol = async (value: string) => {
    const select = root().querySelector<HTMLSelectElement>('[aria-label="Protocol"]')!;
    select.value = value;
    select.dispatchEvent(new Event('input'));
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };

  const waitPoll = () => new Promise((resolve) => setTimeout(resolve, 400));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ProtocolPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(ProtocolPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('edits the settings of every protocol', async () => {
    for (const name of ['websocket', 'socketio', 'mqtt', 'grpc', 'graphql-subscription', 'kafka']) {
      await protocol(name);
      const unchanged = await exerciseControls(
        fixture,
        () => (component as unknown as { model: () => unknown; headers: () => unknown }).model(),
        {
          skip: (control) =>
            control.getAttribute('aria-label') === 'Protocol' ||
            !!control.closest('app-key-value-editor'),
        },
      );
      expect(unchanged, name).toEqual([]);
    }
  });

  it('connects, follows the messages, sends and disconnects', async () => {
    let polls = 0;
    api.responses['realtime.connect'] = { id: 'c1', state: 'connecting' };
    api.responses['realtime.poll'] = () =>
      ++polls === 1
        ? {
            state: 'connected',
            events: [
              { sequence: 1, type: 'open', data: 'ready', time: 1 },
              { sequence: 2, type: 'message', data: { hello: 'world' }, time: 2 },
            ],
          }
        : { state: 'closed', events: [] };
    await protocol('mqtt');
    expect(root().textContent).toContain('Ready to connect');
    await clickButton(fixture, 'Connect');
    await settle();
    await waitPoll();
    await settle();
    expect(root().textContent).toContain('"hello": "world"');
    await clickButton(fixture, 'Subscribe');
    await clickButton(fixture, 'Unsubscribe');
    const [send] = buttons(root(), /^\s*(Send|Publish)/);
    send.click();
    await settle();
    expect(
      api.calls
        .filter((call) => call.operation === 'realtime.send')
        .map((call) => call.payload['action']),
    ).toEqual(['subscribe', 'unsubscribe', 'publish']);
    await waitPoll();
    await settle();
    expect(polls).toBe(2);

    // Connecting again closes the open connection first.
    component['connect']();
    await settle();
    expect(api.calls.some((call) => call.operation === 'realtime.close')).toBe(true);
    await clickButton(fixture, 'Disconnect');
    await settle();
    expect(api.calls.at(-1)).toMatchObject({ operation: 'realtime.close', payload: { id: 'c1' } });
  });

  it('connects to Socket.IO with the transport chosen', async () => {
    api.responses['realtime.connect'] = { id: 'io1', state: 'connecting' };
    api.responses['realtime.poll'] = { state: 'connected', events: [] };
    await protocol('socketio');
    expect(root().textContent).toContain('{"$binary": "<base64>"}');
    const transport = [...root().querySelectorAll('label')]
      .find((label) => label.textContent?.trim().startsWith('Transport'))!
      .querySelector('select')!;
    expect(transport.value).toBe('auto');
    transport.value = 'polling';
    transport.dispatchEvent(new Event('input'));
    transport.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    await clickButton(fixture, 'Connect');
    await settle();
    expect(api.calls.find((call) => call.operation === 'realtime.connect')?.payload).toMatchObject({
      protocol: 'socketio',
      transports: 'polling',
    });
    fixture.destroy();
  });

  it('marks the connection lost when polling fails', async () => {
    api.responses['realtime.connect'] = { id: 'c1', state: 'connecting' };
    api.responses['realtime.poll'] = () => {
      throw new Error('gone');
    };
    await clickButton(fixture, 'Connect');
    await settle();
    await waitPoll();
    await settle();
    expect(root().textContent).toContain('disconnected');
  });

  it('saves the configuration to a collection and opens saved protocol requests', async () => {
    await state.initialize();
    state.tabs.set([]);
    await clickButton(fixture, 'Save to collection');
    await settle();
    expect(state.collections()).toHaveLength(1);
    expect(state.active()?.request.realtime?.protocol).toBe('websocket');
    expect(state.active()?.request.name).toBe('websocket ws://localhost:9001');

    state.newTab({
      ...newRequest('saved'),
      realtime: {
        protocol: 'mqtt',
        url: 'mqtt://broker',
        message: 'hi',
        grpcMessage: '{}',
        topic: 'a/b',
        event: 'message',
        proto: '',
        service: '',
        method: '',
        metadata: '[]',
        tls: false,
        strictSSL: true,
        caPem: '',
        username: 'ana',
        password: '',
        qos: '1',
        headers: [{ key: 'X-A', value: '1', enabled: true }],
      },
    });
    await settle();
    expect(root().querySelector<HTMLInputElement>('[aria-label="Connection URL"]')!.value).toBe(
      'mqtt://broker',
    );
    fixture.destroy();
  });
});
