import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, change, clickButton } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { newRequest } from '../domain/models';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('IntegrationPanel', () => {
  let fixture: ComponentFixture<IntegrationPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const field = (label: string) =>
    [...root().querySelectorAll('label')]
      .find((element) => element.textContent?.trim().startsWith(label))!
      .querySelector('input, select, textarea') as HTMLInputElement;
  const type = async (label: string, value: string) => {
    const control = field(label);
    control.value = value;
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
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
    await clickButton(fixture, 'Save output');
    expect(api.downloads[0].name).toBe('nexo-output.txt');
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
    expect(root().textContent).toContain('Enter the secret value');

    await type('Value', 's3cret');
    await type('Allowed domains', 'api.example.com');
    await clickButton(fixture, 'Save secret');
    await settle();
    expect(api.secretNames).toEqual(['api_token']);
    expect(root().textContent).toContain('{{vault:api_token}}');

    await clickButton(fixture, 'Edit');
    expect(field('Secret name').value).toBe('api_token');
    const [remove] = buttons(root(), /^\s*Remove\s*$/);
    remove.click();
    await settle();
    expect(api.secretNames).toEqual([]);
    await type('Secret name', '');
    await clickButton(fixture, 'Remove secret');
    await settle();
    expect(root().textContent).toContain('Enter a secret name');
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
  });

  it('saves an API definition and generates a collection from it', async () => {
    api.responses['import'] = { documents: [] };
    await clickButton(fixture, 'apis');
    await type('Name', 'Pets');
    await clickButton(fixture, 'Save definition');
    await settle();
    expect(api.documentsStore.some((d) => d.kind === 'api' && d.name === 'Pets')).toBe(true);
    await clickButton(fixture, 'Generate collection');
    await settle();
    expect(api.calls.some((call) => call.operation === 'import')).toBe(true);
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
