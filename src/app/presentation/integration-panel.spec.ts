import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, change, clickButton, fill } from '../testing/controls';
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
