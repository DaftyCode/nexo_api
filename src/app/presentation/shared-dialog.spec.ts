import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiFailure } from '../application/ports';
import { NATIVE_FILES } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import { clickButton, control, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { SharedDialog } from './shared-dialog';
import { SharedState } from './shared-state';
import { WorkspaceState } from './workspace-state';

const document = (id: string, kind: string, name: string, value: unknown): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind,
  name,
  revision: 1,
  updated_at: 0,
  value,
});
const link = {
  collection: 'c1',
  name: 'Shop',
  path: 'D:/Drive/Shop.nexo-collection',
  encrypted: true,
  environments: [],
  conflicts: [],
};

describe('SharedDialog', () => {
  let fixture: ComponentFixture<SharedDialog>;
  let api: TestApi;
  let state: WorkspaceState;
  let shared: SharedState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const open = async (dialog: Parameters<SharedState['dialog']['set']>[0]) => {
    shared.dialog.set(dialog);
    await fixture.whenStable();
  };
  const call = (operation: string) => api.calls.find((each) => each.operation === operation);

  const create = async (chooses = false) => {
    TestBed.configureTestingModule({
      providers: [
        ...testProviders(),
        ...(chooses
          ? [
              {
                provide: NATIVE_FILES,
                useValue: { available: true, choose: async () => 'D:/Picked.nexo-collection' },
              },
            ]
          : []),
      ],
      imports: [SharedDialog],
    });
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push(
      document('c1', 'collection', 'Shop', { info: { name: 'Shop' }, item: [] }),
      document('e1', 'environment', 'Dev', { name: 'Dev', values: [] }),
    );
    await state.refresh();
    shared = TestBed.inject(SharedState);
    fixture = TestBed.createComponent(SharedDialog);
    await fixture.whenStable();
  };

  it('brings a shared collection in, saying why it could not', async () => {
    await create();
    await open({ mode: 'link' });
    expect(text()).toContain('Bring in a shared collection');
    expect(text()).toContain('How sharing works');
    expect(text()).toContain('Nexo makes no call to the cloud');
    await fill(fixture, 'Its file', 'D:/Drive/Team');
    await fill(fixture, 'Team key (only for an encrypted collection)', 'nexo-team-key-x');
    api.responses['shared.link'] = () => {
      throw new ApiFailure(
        'This shared collection is encrypted: paste its team key',
        'validation',
        400,
      );
    };
    await clickButton(fixture, 'Bring it in');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('paste its team key');
    api.responses['shared.link'] = { collection: 'c2' };
    await clickButton(fixture, 'Bring it in');
    expect(call('shared.link')?.payload).toEqual({
      workspace: 'local',
      path: 'D:/Drive/Team.nexo-collection',
      key: 'nexo-team-key-x',
    });
    expect(state.toast()).toMatchObject({ title: 'Shared collection brought in' });
    expect(shared.dialog()).toBeUndefined();
  });

  it('shares a collection with the environments chosen and gives the team key', async () => {
    await create(true);
    await open({ mode: 'share', collection: 'c1' });
    expect((control(root(), 'Where its file goes') as HTMLInputElement).value).toBe(
      'Shop.nexo-collection',
    );
    expect((control(root(), 'Encrypt it with a team key') as HTMLInputElement).checked).toBe(true);
    await clickButton(fixture, 'Choose…');
    (control(root(), 'Dev') as HTMLInputElement).click();
    await fixture.whenStable();
    api.responses['shared.share'] = { collection: 'c1', key: 'nexo-team-key-1' };
    await clickButton(fixture, 'Share the collection');
    expect(call('shared.share')?.payload).toEqual({
      workspace: 'local',
      collection: 'c1',
      path: 'D:/Picked.nexo-collection',
      encrypt: true,
      environments: ['e1'],
    });
    expect((control(root(), 'Team key') as HTMLInputElement).value).toBe('nexo-team-key-1');
    expect(text()).toContain('Give this key to each teammate once');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    await clickButton(fixture, /^Copy$/);
    expect(state.toast()).toMatchObject({ title: 'Copied to the clipboard' });
    await clickButton(fixture, /^Close$/);
    expect(shared.dialog()).toBeUndefined();
    // Without a key to give, it closes at once; a collection unchecked leaves its environment.
    await open({ mode: 'share', collection: 'c1' });
    (control(root(), 'Encrypt it with a team key') as HTMLInputElement).click();
    (control(root(), 'Dev') as HTMLInputElement).click();
    (control(root(), 'Dev') as HTMLInputElement).click();
    await fixture.whenStable();
    api.responses['shared.share'] = { collection: 'c1', key: null };
    await clickButton(fixture, 'Share the collection');
    expect(
      api.calls.filter((each) => each.operation === 'shared.share').at(-1)?.payload,
    ).toMatchObject({
      encrypt: false,
      environments: [],
    });
    expect(shared.dialog()).toBeUndefined();
  });

  it('brings a collection in from a server with its credential', async () => {
    await create();
    await open({ mode: 'link' });
    await fill(fixture, 'Where the team keeps it', 'url');
    expect(text()).toContain('never on a schedule');
    await fill(fixture, 'URL of its file on the server', ' https://dav.test/Team.nexo-collection ');
    await fill(fixture, 'Sign in with', 'basic');
    await fill(fixture, 'User', 'ana');
    await fill(fixture, 'Password', 'pw');
    api.responses['shared.link'] = { collection: 'c2' };
    await clickButton(fixture, 'Bring it in');
    expect(call('shared.link')?.payload).toEqual({
      workspace: 'local',
      url: 'https://dav.test/Team.nexo-collection',
      credential: { scheme: 'basic', user: 'ana', secret: 'pw' },
    });
    // Without signing in, no credential goes.
    await open({ mode: 'share', collection: 'c1' });
    await fill(fixture, 'Where the team keeps it', 'url');
    await fill(fixture, 'URL of its file on the server', 'https://dav.test/Shop.nexo-collection');
    api.responses['shared.share'] = { collection: 'c1' };
    await clickButton(fixture, 'Share the collection');
    expect(call('shared.share')?.payload).toMatchObject({
      url: 'https://dav.test/Shop.nexo-collection',
    });
    expect(call('shared.share')?.payload['credential']).toBeUndefined();
    shared.show([{ ...link, kind: 'url', path: 'https://dav.test/Shop.nexo-collection' }]);
    await open({ mode: 'manage', collection: 'c1' });
    expect(text()).toContain('Server');
  });

  it('shows how a collection is shared, what waits for the person, and stops sharing', async () => {
    await create();
    shared.show([
      {
        ...link,
        conflicts: [
          { id: 'r1', name: 'List' },
          { id: '', name: '' },
        ],
        error: 'The folder is not there',
      },
    ]);
    await open({ mode: 'manage', collection: 'c1' });
    expect(text()).toContain(link.path);
    expect(text()).toContain('Both of you changed List.');
    expect(text()).toContain('Both of you changed the collection.');
    expect(text()).toContain('The folder is not there');
    api.responses['shared.resolve'] = { links: [link] };
    await clickButton(fixture, 'Keep mine');
    expect(call('shared.resolve')?.payload).toMatchObject({ id: 'r1', keep: 'mine' });
    api.responses['shared.sync'] = { links: [link] };
    await clickButton(fixture, 'Reload');
    expect(state.toast()).toMatchObject({ title: 'Reloaded from the shared file' });
    api.responses['shared.key'] = { key: 'nexo-team-key-1' };
    await clickButton(fixture, 'Show the team key');
    expect((control(root(), 'Team key') as HTMLInputElement).value).toBe('nexo-team-key-1');
    state.confirm = () => false;
    await clickButton(fixture, 'Stop sharing');
    expect(call('shared.unlink')).toBeUndefined();
    state.confirm = () => true;
    api.responses['shared.unlink'] = { links: [] };
    await clickButton(fixture, 'Stop sharing');
    expect(state.toast()).toMatchObject({ title: 'The collection is no longer shared' });
    expect(shared.dialog()).toBeUndefined();
  });
});
