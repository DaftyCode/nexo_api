import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { GitRemotes } from './git-remotes';
import { WorkspaceState } from './workspace-state';

const ok = (stdout = '') => ({ success: true, stdout, stderr: '' });

describe('GitRemotes', () => {
  let fixture: ComponentFixture<GitRemotes>;
  let api: TestApi;
  let state: WorkspaceState;
  let emitted: string[];
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  const control = (label: string) => {
    const found = [...root().querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    if (!found) throw new Error(`No field ${label}`);
    return found.querySelector('input') as HTMLInputElement;
  };
  const type = async (label: string, value: string) => {
    const input = control(label);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  const click = async (text: string | RegExp) => {
    await clickButton(fixture, text);
    await settle();
  };
  const calls = (operation: string) =>
    api.gitCalls.filter((call) => call.operation === operation).map((call) => call.payload);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [GitRemotes],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(GitRemotes);
    emitted = [];
    fixture.componentInstance.result.subscribe((text) => emitted.push(text));
    await settle();
  });

  it('lists, adds and removes remotes', async () => {
    expect(root().textContent).toContain('No remotes.');
    let remotes = [{ name: 'origin', url: 'https://github.com/acme/api.git' }];
    api.responses['git.remote.list'] = () => ({ remotes });
    api.responses['git.remote.add'] = ok();
    api.responses['git.remote.remove'] = () => ((remotes = []), ok());
    await type('Remote name', 'upstream');
    await type('Remote URL', 'git@github.com:acme/api.git');
    await click('Add remote');
    expect(calls('remote.add')).toEqual([
      { workspace: 'local', remote: 'upstream', url: 'git@github.com:acme/api.git' },
    ]);
    expect(control('Remote URL').value).toBe('');
    expect(root().textContent).toContain('https://github.com/acme/api.git');
    expect(emitted).toEqual(['Done.']);

    state.confirm = () => false;
    await click('Remove remote origin');
    expect(calls('remote.remove')).toEqual([]);
    state.confirm = () => true;
    await click('Remove remote origin');
    expect(calls('remote.remove')).toEqual([{ workspace: 'local', remote: 'origin' }]);
    expect(root().textContent).toContain('No remotes.');

    // A project without a repository has no remotes to list.
    api.responses['git.remote.list'] = () => {
      throw new Error('Initialize the repository first (Git → Init)');
    };
    state.workspaceId.set('other');
    await settle();
    expect(root().textContent).toContain('No remotes.');
  });

  it('shows what to do when Git fails, with its own words apart', async () => {
    api.responses['git.remote.add'] = () => {
      throw new Error('Use an https:// or ssh:// address, or user@host:path');
    };
    await click('Add remote');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      'Use an https:// or ssh:// address',
    );
    expect(root().querySelector('[role="alert"] pre')).toBeNull();
    api.responses['git.push'] = () => {
      throw new Error(
        'The remote has commits that your branch does not. Pull first, then push.\n\n ! [rejected] main -> main',
      );
    };
    await click(/^\s*Push\s*$/);
    expect(root().querySelector('[role="alert"] p')?.textContent).toContain('Pull first');
    expect(root().querySelector('[role="alert"] pre')?.textContent).toContain('[rejected]');
    await click('Dismiss error');
    expect(root().querySelector('[role="alert"]')).toBeNull();
  });

  it('fetches, pulls into the workspace and pushes, with force only when confirmed', async () => {
    const existing: WorkspaceDocument = {
      id: 'c1',
      workspace_id: 'local',
      kind: 'collection',
      name: 'Shop',
      revision: 1,
      updated_at: 0,
      value: { info: { name: 'Shop' }, item: [] },
    };
    api.documentsStore.push(existing);
    await state.refresh();
    api.responses['git.fetch'] = ok('fetched');
    api.responses['git.pull'] = ok('Fast-forward');
    api.responses['git.push'] = ok();
    api.responses['git.files'] = {
      files: [
        { id: 'c1', value: { info: { name: 'Shop v2' }, item: [] } },
        { id: 'c2', value: { info: { name: 'Users' }, item: [] } },
      ],
    };
    await click(/^\s*Fetch\s*$/);
    expect(calls('fetch')).toEqual([{ workspace: 'local', remote: 'origin' }]);
    expect(emitted.at(-1)).toBe('fetched');

    control('Pull with rebase').click();
    await fixture.whenStable();
    await click(/^\s*Pull\s*$/);
    expect(calls('pull')).toEqual([{ workspace: 'local', remote: 'origin', rebase: true }]);
    expect(api.documentsStore.map((d) => d.name).sort()).toEqual(['Shop v2', 'Users']);
    expect(
      state
        .collections()
        .map((d) => d.name)
        .sort(),
    ).toEqual(['Shop v2', 'Users']);
    expect(state.notice()).toBe('Collections updated from the repository');
    expect(emitted.at(-1)).toContain('Collections: 1 added, 1 updated, 0 unchanged.');

    await click(/^\s*Push\s*$/);
    expect(calls('push')).toEqual([{ workspace: 'local', remote: 'origin' }]);
    control('Push with force with lease').click();
    await fixture.whenStable();
    state.confirm = () => false;
    await click(/^\s*Push\s*$/);
    expect(calls('push')).toHaveLength(1);
    state.confirm = () => true;
    await click(/^\s*Push\s*$/);
    expect(calls('push').at(-1)).toEqual({
      workspace: 'local',
      remote: 'origin',
      forceWithLease: true,
    });

    // A pull that Git reports as failed brings nothing in.
    const saved = api.documentsStore.length;
    api.responses['git.pull'] = { success: false, stdout: '', stderr: 'fatal: no upstream' };
    await click(/^\s*Pull\s*$/);
    expect(emitted.at(-1)).toBe('fatal: no upstream');
    expect(api.documentsStore).toHaveLength(saved);
  });

  it('clones into a new workspace and opens it, and leaves no workspace when it fails', async () => {
    const deleted = vi.spyOn(api, 'deleteWorkspace');
    await click('Clone into a new workspace');
    expect(root().textContent).toContain('Write the address of the repository to clone');

    await type('Repository URL', 'https://github.com/acme/orders-api.git');
    expect(control('New workspace name').placeholder).toBe('orders-api');
    api.responses['git.clone'] = { success: false, stdout: '', stderr: 'fatal: not found' };
    await click('Clone into a new workspace');
    expect(deleted).toHaveBeenCalledWith('fixture');
    expect(root().textContent).toContain('fatal: not found');
    expect(state.workspaceId()).toBe('local');

    api.responses['git.clone'] = ok();
    api.responses['git.files'] = { files: [{ id: 'c9', value: { info: { name: 'Orders' } } }] };
    await type('New workspace name', 'Orders');
    await click('Clone into a new workspace');
    expect(calls('clone').at(-1)).toEqual({
      workspace: 'fixture',
      url: 'https://github.com/acme/orders-api.git',
    });
    expect(api.documentsStore).toEqual([
      expect.objectContaining({ id: 'c9', workspace_id: 'fixture', name: 'Orders' }),
    ]);
    expect(state.workspaceId()).toBe('fixture');
    expect(state.notice()).toBe('Repository cloned into a new workspace');
    expect(emitted.at(-1)).toBe('Collections: 1 added, 0 updated, 0 unchanged.');
    expect(control('Repository URL').value).toBe('');
    expect(buttons(root(), 'Clone into a new workspace')).toHaveLength(1);
  });
});
