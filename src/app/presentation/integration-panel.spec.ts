import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, change, clickButton, fill, valueOf } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { newRequest } from '../domain/models';
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

  it('runs every Git action and shows the parsed status', async () => {
    api.responses['git.status'] = {
      success: true,
      stdout: '# branch.head main\n# branch.ab +1 -2\n? new.json\n1 .M N... 1 1 1 a b api.json',
      stderr: '',
    };
    api.responses['git.commit'] = { success: false, stdout: '', stderr: '' };
    fixture.componentRef.setInput('section', 'git');
    await fixture.whenStable();
    expect(root().textContent).toContain('Git projects');
    for (const button of buttons(
      root(),
      /Initialize|Export collections|status|diff|log|branches|stash/,
    ))
      button.click();
    await settle();
    expect(root().textContent).toContain('main');
    expect(root().textContent).toContain('new.json');
    await type('Branch', 'feature/x');
    await type('Commit message', 'Add users');
    await clickButton(fixture, 'Create branch');
    await clickButton(fixture, 'Switch branch');
    await clickButton(fixture, 'Commit changes');
    await settle();
    expect(api.gitCalls.map((call) => call.operation)).toEqual(
      expect.arrayContaining(['init', 'export', 'status', 'diff', 'log', 'branch', 'checkout']),
    );
    expect(api.gitCalls.at(-1)).toEqual({
      operation: 'commit',
      payload: { workspace: 'local', branch: 'feature/x', message: 'Add users' },
    });
    expect(root().textContent).toContain('Git reported an error.');
    // A commit that Git refuses is said in a toast.
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The changes could not be committed',
    });
    await clickButton(fixture, 'Save output');
    await settle();
    expect(api.downloads[0].name).toBe('nexo-output.txt');
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'File downloaded',
      message: 'toast.downloaded',
      params: { v0: 'nexo-output.txt' },
    });
  });

  it('shows the output of a remote operation and the status it leaves', async () => {
    api.responses['git.fetch'] = { success: true, stdout: 'From github.com:acme/api', stderr: '' };
    api.responses['git.status'] = {
      success: true,
      stdout: '# branch.head main\n# branch.ab +0 -3',
      stderr: '',
    };
    fixture.componentRef.setInput('section', 'git');
    await fixture.whenStable();
    await clickButton(fixture, /^\s*Fetch\s*$/);
    await settle();
    expect(root().textContent).toContain('From github.com:acme/api');
    expect(root().textContent).toContain('↓3');
    // Without a repository there is no status to show.
    api.responses['git.status'] = () => {
      throw new Error('Initialize the repository first (Git → Init)');
    };
    await clickButton(fixture, /^\s*Fetch\s*$/);
    await settle();
    expect(root().textContent).toContain('↓3');
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

  it('generates code for the active request', async () => {
    api.responses['codegen'] = ({ language }: Record<string, unknown>) => ({
      code: `snippet in ${String(language)}`,
    });
    fixture.componentRef.setInput('section', 'code');
    await fixture.whenStable();
    await clickButton(fixture, 'Generate snippet');
    await settle();
    expect(root().textContent).toContain('Open a request first');

    state.newTab({ ...newRequest('r1'), url: 'https://api.example.com' });
    await type('Language', 'python');
    await type('Variant', 'requests');
    await clickButton(fixture, 'Generate snippet');
    await settle();
    expect(root().textContent).toContain('snippet in python');
    expect(api.calls.at(-1)?.payload).toMatchObject({ language: 'python', variant: 'requests' });
  });

  it('manages the workspace in the general settings', async () => {
    state.confirm = () => true;
    await state.initialize();
    await fixture.whenStable();
    expect(root().textContent).toContain('Workspace settings');
    await type('Workspace name', 'Renamed');
    await clickButton(fixture, 'Rename');
    await clickButton(fixture, 'Refresh workspace');
    await clickButton(fixture, 'Delete workspace');
    await settle();
    expect(state.notice()).toBeTruthy();
  });

  it('saves, edits and removes vault secrets with their allowed domains', async () => {
    await clickButton(fixture, 'vault');
    await settle();
    expect(root().textContent).toContain('No secrets saved yet.');
    await type('Secret name', 'api_token');
    await clickButton(fixture, 'Save secret');
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The secret could not be saved',
      detail: 'Enter the secret value',
    });

    await type('Value', 's3cret');
    await type('Allowed domains', 'api.example.com');
    await clickButton(fixture, 'Save secret');
    await settle();
    expect(api.secretNames).toEqual(['api_token']);
    expect(root().textContent).toContain('{{vault:api_token}}');
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Secret saved',
      message: 'toast.secretSaved',
      params: { v0: '{{vault:api_token}}' },
    });

    await clickButton(fixture, 'Edit');
    expect(field('Secret name').value).toBe('api_token');
    const [remove] = buttons(root(), /^\s*Remove\s*$/);
    remove.click();
    await settle();
    expect(api.secretNames).toEqual([]);
    expect(state.toast()).toMatchObject({ title: 'Secret removed', params: { v0: 'api_token' } });
    await type('Secret name', '');
    await clickButton(fixture, 'Remove secret');
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The secret could not be removed',
      detail: 'Enter a secret name',
    });
  });

  it('exchanges an OAuth token and uses it in the active request', async () => {
    api.responses['oauth.token'] = {
      status: 200,
      body: { access_token: 'abcdefghijklmnopqrstuvwxyz', token_type: 'Bearer', expires_in: 60 },
    };
    await clickButton(fixture, 'oauth');
    await clickButton(fixture, 'Get token and use in request');
    await settle();
    expect(root().textContent).toContain('Enter the full token endpoint URL');

    state.newTab(newRequest('r1'));
    await type('Token endpoint', 'https://auth.example.com/token');
    await type('Grant type', 'authorization_code');
    for (const [label, value] of [
      ['Client ID', 'client'],
      ['Client secret', 'secret'],
      ['Scope', 'read'],
      ['Authorization code', 'code-1'],
      ['Redirect URI', 'http://localhost/cb'],
      ['PKCE code verifier', 'verifier'],
    ])
      await type(label, value);
    await clickButton(fixture, 'Get token and use in request');
    await settle();
    expect(api.calls.at(-1)?.payload['fields']).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'http://localhost/cb',
      code_verifier: 'verifier',
    });
    expect(root().textContent).toContain('abcdef…wxyz');
    expect(state.active()?.request.auth).toMatchObject({
      type: 'bearer',
      token: 'abcdefghijklmnopqrstuvwxyz',
    });
  });

  it('lists the revisions of a document and restores one', async () => {
    await state.createCollection('Orders');
    const [collection] = state.collections();
    api.revisions = async () => [{ revision: 1, changed_at: 0, value: collection }];
    await clickButton(fixture, 'revisions');
    await clickButton(fixture, 'Load revisions');
    await settle();
    expect(root().textContent).toContain('Choose a resource');

    await type('Document', collection.id);
    await clickButton(fixture, 'Load revisions');
    await settle();
    await clickButton(fixture, 'Restore as new revision');
    await settle();
    expect(root().textContent).toContain('Revision restored as a new revision.');
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Revision restored',
      params: { v0: 'Orders' },
    });
  });

  it('shows the API definitions', async () => {
    await clickButton(fixture, 'apis');
    expect(root().querySelector('app-api-definitions')).not.toBeNull();
  });

  it('starts, follows and stops a load test', async () => {
    api.responses['performance'] = ({ action }: Record<string, unknown>) =>
      action === 'status'
        ? {
            state: 'finished',
            completed: 10,
            errors: 1,
            average: 12.4,
            p95: 30,
            summary: { requests: 10, errors: 1, average: 12, p95: 30, rps: 5 },
          }
        : { id: 'load-1' };
    await clickButton(fixture, 'performance');
    await clickButton(fixture, 'Start run');
    await settle();
    expect(root().textContent).toContain('Open a request first');

    state.newTab({ ...newRequest('r1'), url: 'https://api.example.com' });
    for (const control of root().querySelectorAll('input[type="number"], select')) change(control);
    await clickButton(fixture, 'Start run');
    await settle();
    expect(root().textContent).toContain('running');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settle();
    expect(root().textContent).toContain('finished');
    await clickButton(fixture, 'Stop');
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      operation: 'performance.cancel',
      payload: { id: 'load-1' },
    });
  });
});
