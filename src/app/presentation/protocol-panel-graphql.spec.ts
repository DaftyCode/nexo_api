import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, codeText, fill, renderDeferred } from '../testing/controls';
import { By } from '@angular/platform-browser';
import { introspection } from '../testing/graphql';
import { clientSchema, GraphqlQueryEditor } from './graphql-query-editor';
import { ProtocolPanel } from './protocol-panel';
import { WorkspaceState } from './workspace-state';

describe('ProtocolPanel', () => {
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
    await fixture.whenStable();
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
});
