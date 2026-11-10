import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  buttons,
  clickButton,
  codeText,
  exerciseControls,
  fill,
  renderDeferred,
} from '../testing/controls';
import { By } from '@angular/platform-browser';
import { introspection } from '../testing/graphql';
import { GraphqlQueryEditor, clientSchema } from './graphql-query-editor';
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

  it('loads the schema of a subscription endpoint and suggests its fields', async () => {
    api.responses['request'] = {
      status: 200,
      statusText: 'OK',
      headers: [],
      body: JSON.stringify(introspection),
      time: 1,
      size: 1,
      assertions: [],
      logs: [],
    };
    await protocol('graphql-subscription');
    const url = root().querySelector<HTMLInputElement>('[aria-label="Connection URL"]')!;
    url.value = 'wss://api.test/graphql';
    url.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root().textContent).toContain('Load the schema, by introspection over HTTP');
    await fill(fixture, 'Key', 'Authorization');
    await fill(fixture, 'Value', 'Bearer t');
    await clickButton(fixture, 'Load schema');
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    const sent = api.calls.find((call) => call.operation === 'request')!.payload['request'] as {
      url: { raw: string };
      header: { key: string; value: string }[];
    };
    // Over HTTP at the same address, with the connection headers.
    expect(JSON.stringify(sent)).toContain('https://api.test/graphql');
    expect(JSON.stringify(sent)).toContain('Bearer t');
    expect(state.schemaFor('wss://api.test/graphql')?.queryType).toBe('Query');
    // The same schema serves the queries of the endpoint.
    expect(state.schemaFor('https://api.test/graphql')?.queryType).toBe('Query');
    expect(root().textContent).toContain('suggested as you type');
    expect(buttons(root(), 'Reload schema')).toHaveLength(1);
    await renderDeferred(fixture);
    const editor = fixture.debugElement.query(By.directive(GraphqlQueryEditor))
      .componentInstance as GraphqlQueryEditor;
    expect(clientSchema(state.schemaFor('wss://api.test/graphql'))).toBeDefined();
    expect(editor.schema()?.queryType).toBe('Query');

    api.responses['request'] = () => {
      throw new Error('Not a GraphQL endpoint');
    };
    await clickButton(fixture, 'Reload schema');
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    expect(state.error()).toBe('Not a GraphQL endpoint');
  });

  it('subscribes to a GraphQL subscription and shows its results', async () => {
    let polls = 0;
    api.responses['realtime.connect'] = { id: 's1', state: 'connecting' };
    api.responses['realtime.poll'] = () =>
      ++polls === 1
        ? {
            state: 'connected',
            events: [
              { sequence: 1, type: 'open', data: 'Subscribed', time: 1 },
              { sequence: 2, type: 'next', data: { data: { ticks: 1 } }, time: 2 },
            ],
          }
        : { state: 'connected', events: [] };
    await protocol('graphql-subscription');
    expect(root().textContent).toContain('Subscription protocol');
    expect(buttons(root(), 'Send message')).toEqual([]);
    await fill(fixture, 'GraphQL subscription', 'subscription { ticks }');
    expect(codeText(root(), 'GraphQL subscription')).toBe('subscription { ticks }');
    await clickButton(fixture, 'Connect');
    await settle();
    expect(api.calls.find((call) => call.operation === 'realtime.connect')?.payload).toMatchObject({
      protocol: 'graphql-subscription',
      query: 'subscription { ticks }',
      variables: '{}',
      connectionParams: '{}',
      graphqlProtocol: 'graphql-transport-ws',
    });
    await waitPoll();
    await settle();
    expect(root().textContent).toContain('"ticks": 1');
    await clickButton(fixture, 'Disconnect');
    await settle();
    expect(api.calls.at(-1)).toMatchObject({ operation: 'realtime.close', payload: { id: 's1' } });

    // Over server-sent events: no connection parameters, the headers authorize it.
    const kind = [...root().querySelectorAll('label')]
      .find((label) => label.textContent?.trim().startsWith('Subscription protocol'))!
      .querySelector('select')!;
    expect(root().textContent).toContain('Connection parameters (JSON)');
    kind.value = 'graphql-sse';
    kind.dispatchEvent(new Event('input'));
    kind.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(root().textContent).not.toContain('Connection parameters (JSON)');
    expect(root().textContent).toContain('results stream back as server-sent events');
    await clickButton(fixture, 'Connect');
    await settle();
    expect(
      api.calls.filter((call) => call.operation === 'realtime.connect').at(-1)?.payload,
    ).toMatchObject({ graphqlProtocol: 'graphql-sse' });
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

  it('connects to Kafka with SASL, produces with key and headers, and reads from an offset', async () => {
    api.responses['realtime.connect'] = { id: 'k1', state: 'connecting' };
    api.responses['realtime.poll'] = { state: 'connected', events: [] };
    await protocol('kafka');
    const field = (label: string) =>
      [...root().querySelectorAll('label')]
        .find((element) => element.textContent?.trim().startsWith(label))!
        .querySelector('input, select') as HTMLInputElement;
    const set = async (label: string, value: string) => {
      const control = field(label);
      control.value = value;
      control.dispatchEvent(new Event('input'));
      control.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    expect(root().textContent).toContain('Bootstrap servers as host:port');
    root().querySelector<HTMLInputElement>('[aria-label="Connection URL"]')!.value = 'broker:9092';
    root()
      .querySelector<HTMLInputElement>('[aria-label="Connection URL"]')!
      .dispatchEvent(new Event('input'));
    await set('SASL', 'SCRAM-SHA-256');
    expect(root().textContent).toContain('{{vault:name}}');
    await set('Username', 'app');
    await set('Password', '{{vault:kafka}}');
    field('Use TLS').click();
    await fixture.whenStable();
    await clickButton(fixture, 'Connect');
    await settle();
    expect(api.calls.find((call) => call.operation === 'realtime.connect')?.payload).toMatchObject({
      protocol: 'kafka',
      url: 'broker:9092',
      tls: true,
      saslMechanism: 'SCRAM-SHA-256',
      username: 'app',
      password: '{{vault:kafka}}',
      headers: [],
    });
    await waitPoll();
    await settle();
    await set('Topic', 'orders');
    await set('Key', 'k1');
    await set('Partition', '2');
    const [headerKey] = root().querySelectorAll<HTMLInputElement>(
      'app-key-value-editor [aria-label="Key"]',
    );
    headerKey.value = 'trace';
    headerKey.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    await clickButton(fixture, 'Produce message');
    await settle();
    expect(api.calls.at(-1)?.payload).toMatchObject({
      action: 'produce',
      topic: 'orders',
      key: 'k1',
      partition: 2,
      headers: [expect.objectContaining({ key: 'trace' })],
    });
    await set('Read from', 'offset');
    await set('Offset', '15');
    await clickButton(fixture, 'Read topic');
    await settle();
    expect(api.calls.at(-1)?.payload).toMatchObject({
      action: 'subscribe',
      from: 'offset',
      offset: 15,
    });
    await clickButton(fixture, 'Stop reading');
    await clickButton(fixture, 'List topics');
    await settle();
    expect(api.calls.slice(-2).map((call) => call.payload['action'])).toEqual([
      'unsubscribe',
      'topics',
    ]);
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

  it('invokes a gRPC method and reports invalid JSON', async () => {
    api.responses['grpc'] = { message: { reply: 'Hello Nexo' } };
    await protocol('grpc');
    expect(root().textContent).toContain('Invoke a method to see its response.');
    await clickButton(fixture, 'Invoke method');
    await settle();
    expect(root().textContent).toContain('Hello Nexo');

    component['model'].update((m) => ({ ...m, grpcMessage: '{ broken' }));
    await fixture.whenStable();
    await clickButton(fixture, 'Invoke method');
    await settle();
    expect(root().textContent).toContain('The request message must be valid JSON');
    await clickButton(fixture, 'Dismiss error');
  });

  it('discovers services by reflection or from the proto, and calls them', async () => {
    const method = (name: string, clientStreaming: boolean, serverStreaming: boolean) => ({
      name,
      input: 'demo.Hello',
      output: 'demo.Hello',
      clientStreaming,
      serverStreaming,
    });
    api.responses['grpc'] = (payload: Record<string, unknown>) =>
      payload['method']
        ? { message: { reply: `called ${String(payload['method'])}` } }
        : payload['reflection']
          ? {
              services: ['demo.Greeter', 'demo.Admin'],
              methods: {
                'demo.Greeter': [method('Say', false, false), method('Chat', true, true)],
                'demo.Admin': [method('Upload', true, false), method('Watch', false, true)],
              },
              reflection: 'v1alpha',
            }
          : { services: ['demo.Proto'], methods: { 'demo.Proto': [method('Get', false, false)] } };
    await protocol('grpc');
    const reflection = [
      ...root().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((input) => input.closest('label')?.textContent?.includes('Use server reflection'))!;
    reflection.click();
    await fixture.whenStable();
    expect(root().textContent).not.toContain('Proto definition');
    const url = root().querySelector<HTMLInputElement>('[aria-label="Connection URL"]')!;
    url.value = '';
    url.dispatchEvent(new Event('input'));
    await clickButton(fixture, 'Discover services');
    await settle();
    expect(root().textContent).toContain('Enter the gRPC server address (host:port)');

    url.value = 'localhost:50051';
    url.dispatchEvent(new Event('input'));
    await clickButton(fixture, 'Discover services');
    await settle();
    expect(api.calls.at(-1)?.payload).toMatchObject({ reflection: true, url: 'localhost:50051' });
    expect(api.calls.at(-1)?.payload['proto']).toBeUndefined();
    expect(root().textContent).toContain('Described by server reflection v1alpha');
    const labelled = (text: string) =>
      [...root().querySelectorAll('label')]
        .find((label) => label.textContent?.trim().startsWith(text))!
        .querySelector('select')!;
    const service = labelled('Service');
    const methodSelect = labelled('Method');
    expect(service.value).toBe('demo.Greeter');
    expect(methodSelect.value).toBe('Say');
    expect(root().textContent).toContain('Unary');
    methodSelect.value = 'Chat';
    methodSelect.dispatchEvent(new Event('input'));
    methodSelect.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(root().textContent).toContain('Bidirectional streaming');
    service.value = 'demo.Admin';
    service.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(component['model']().method).toBe('Upload');
    expect(root().textContent).toContain('Client streaming');
    await clickButton(fixture, 'Invoke method');
    await settle();
    expect(api.calls.at(-1)?.payload).toMatchObject({
      reflection: true,
      service: 'demo.Admin',
      method: 'Upload',
    });
    expect(root().textContent).toContain('called Upload');

    // Back to the pasted proto: its own services, found again.
    reflection.click();
    await fixture.whenStable();
    expect(root().querySelector<HTMLInputElement>('.row input')).not.toBeNull();
    await clickButton(fixture, 'Discover services');
    await settle();
    expect(api.calls.at(-1)?.payload['proto']).toContain('service Greeter');
    expect(component['model']()).toMatchObject({ service: 'demo.Proto', method: 'Get' });
    expect(root().textContent).not.toContain('Described by server reflection');
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
