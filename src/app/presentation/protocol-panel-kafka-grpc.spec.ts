import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { clickButton } from '../testing/controls';
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
});
