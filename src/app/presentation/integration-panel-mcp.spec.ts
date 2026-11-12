import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, fill, valueOf } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('IntegrationPanel', () => {
  let fixture: ComponentFixture<IntegrationPanel>;

  let api: TestApi;

  let state: WorkspaceState;

  const root = () => fixture.nativeElement as HTMLElement;

  // Inputs, selects and code editors alike.
  const field = (label: string) => ({ value: valueOf(root(), label) });

  const type = (label: string, value: string) => fill(fixture, label, value);

  const settle = async () => {
    for (let i = 0; i < 3; i++) await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [IntegrationPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(IntegrationPanel);
    await fixture.whenStable();
  });

  it('calls an MCP server and lists its tools, texts and errors', async () => {
    api.responses['mcp.request'] = {
      status: 200,
      sessionId: 'session-1',
      result: [
        { result: { tools: [{ name: 'echo', description: 'Echoes text' }] } },
        { result: { content: [{ text: 'hello' }] } },
        { error: { message: 'Unknown tool' } },
      ],
    };
    fixture.componentRef.setInput('section', 'mcp');
    await fixture.whenStable();
    await type('Parameters (JSON)', '{ broken');
    await clickButton(fixture, 'Send JSON-RPC');
    await settle();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      'Parameters must be valid JSON',
    );
    await clickButton(fixture, 'Dismiss error');
    expect(root().querySelector('[role="alert"]')).toBeNull();

    await type('Method', 'tools/call');
    await type('Parameters (JSON)', '{"name":"echo"}');
    await clickButton(fixture, 'Send JSON-RPC');
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      operation: 'mcp.request',
      payload: { method: 'tools/call', params: { name: 'echo' } },
    });
    for (const text of ['session-1', 'echo', 'Echoes text', 'hello', 'Unknown tool'])
      expect(root().textContent).toContain(text);
  });

  it('browses the resources and prompts of an MCP server in one session', async () => {
    api.responses['mcp.request'] = ({ method, params, url }: Record<string, unknown>) => {
      const answer = (result: unknown) => ({
        status: 200,
        sessionId: url === 'http://localhost:3000/mcp' ? 'session-1' : undefined,
        result: { jsonrpc: '2.0', id: 1, result },
      });
      const p = params as { uri?: string; name?: string; arguments?: Record<string, string> };
      switch (method) {
        case 'resources/list':
          return answer({
            resources: [{ uri: 'nexo://shop', name: 'Shop', description: 'Collection' }],
          });
        case 'resources/templates/list':
          return answer({ resourceTemplates: [{ uriTemplate: 'nexo://{id}', name: 'By id' }] });
        case 'resources/read':
          return answer({ contents: [{ uri: p.uri, text: `contents of ${p.uri}` }] });
        case 'prompts/list':
          return answer({
            prompts: [
              {
                name: 'write_tests',
                description: 'Tests for a request',
                arguments: [
                  { name: 'request', required: true },
                  { name: 'workspace', required: false },
                ],
              },
            ],
            tools: [{ name: 'send_request', description: 'Sends' }],
          });
        case 'prompts/get':
          return answer({
            messages: [
              {
                role: 'user',
                content: { type: 'text', text: `tests for ${p.arguments?.['request']}` },
              },
            ],
          });
        default:
          return answer({});
      }
    };
    const sent = () => api.calls.filter((c) => c.operation === 'mcp.request').map((c) => c.payload);
    fixture.componentRef.setInput('section', 'mcp');
    await fixture.whenStable();
    await type('Method', 'resources/list');
    await clickButton(fixture, 'Send JSON-RPC');
    await settle();
    expect(sent()[0]).not.toHaveProperty('sessionId');
    await clickButton(fixture, 'Read Shop');
    await settle();
    expect(sent().at(-1)).toMatchObject({
      method: 'resources/read',
      params: { uri: 'nexo://shop' },
      sessionId: 'session-1',
    });
    expect(root().textContent).toContain('contents of nexo://shop');

    await type('Method', 'resources/templates/list');
    await clickButton(fixture, 'Send JSON-RPC');
    await settle();
    const calls = sent().length;
    await clickButton(fixture, 'Use template By id');
    expect(sent()).toHaveLength(calls);
    expect(field('Method').value).toBe('resources/read');
    expect(JSON.parse(field('Parameters (JSON)').value)).toEqual({ uri: 'nexo://{id}' });

    await type('Method', 'prompts/list');
    await clickButton(fixture, 'Send JSON-RPC');
    await settle();
    const get = buttons(root(), 'Get prompt write_tests')[0];
    expect(get.disabled).toBe(true);
    await type('request *', 'List orders');
    expect(get.disabled).toBe(false);
    get.click();
    await settle();
    expect(sent().at(-1)).toMatchObject({
      method: 'prompts/get',
      params: { name: 'write_tests', arguments: { request: 'List orders' } },
    });
    expect(root().textContent).toContain('tests for List orders');

    await type('Method', 'prompts/list');
    await clickButton(fixture, 'Send JSON-RPC');
    await settle();
    await clickButton(fixture, 'Use tool send_request');
    expect(field('Method').value).toBe('tools/call');
    expect(JSON.parse(field('Parameters (JSON)').value)).toEqual({
      name: 'send_request',
      arguments: {},
    });

    // Another server starts without the first one's session.
    await type('Server URL', 'http://localhost:4000/mcp');
    await clickButton(fixture, 'Send JSON-RPC');
    await settle();
    expect(sent().at(-1)).not.toHaveProperty('sessionId');
  });
});
