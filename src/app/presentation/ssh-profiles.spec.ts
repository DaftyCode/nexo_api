import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, fill, valueOf } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('SshProfiles', () => {
  let fixture: ComponentFixture<IntegrationPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  const click = async (label: string | RegExp) => {
    await clickButton(fixture, label);
    await settle();
  };
  const save = () => buttons(root(), /^Save$/)[0];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [IntegrationPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(IntegrationPanel);
    await settle();
    await click(/^SSH$/);
  });

  it('creates a profile with its password in the vault and trusts its server once', async () => {
    expect(text()).toContain('No SSH profiles yet.');
    await click('New SSH profile');
    expect(text()).toContain('Enter the host of the SSH server');
    expect(save().disabled).toBe(true);
    await fill(fixture, 'Name', 'Bastion');
    await fill(fixture, 'SSH server', 'bastion.test');
    await fill(fixture, 'User', 'ana');
    expect(text()).toContain('Enter the password of the SSH profile');
    await fill(fixture, 'Password', 'pw');
    await click(/^Save$/);
    const [saved] = api.documentsStore;
    expect(saved).toMatchObject({
      kind: 'ssh-profile',
      name: 'Bastion',
      value: { host: 'bastion.test', port: 22, username: 'ana', auth: 'password' },
    });
    expect(api.secretNames).toEqual([`ssh-${saved.id}`]);
    expect(state.toast()).toMatchObject({ title: 'SSH profile saved', params: { v0: 'Bastion' } });
    expect(text()).toContain('ana@bastion.test:22');

    let trusted = false;
    const report = () => ({
      trusted,
      host: 'bastion.test',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
    });
    api.responses['ssh.test'] = report;
    api.responses['ssh.trust'] = () => {
      trusted = true;
      return { trusted };
    };
    await click(/^Test$/);
    expect(text()).toContain('Nexo does not know this server yet');
    expect(text()).toContain('ssh-ed25519 SHA256:abc');
    await click('Trust this key');
    expect(api.calls.find((call) => call.operation === 'ssh.trust')?.payload).toEqual({
      workspace: 'local',
      host: 'bastion.test',
      port: 22,
      fingerprint: 'SHA256:abc',
    });
    expect(text()).toContain('Signed in. The key of the server is trusted:');
    expect(buttons(root(), 'Trust this key')).toEqual([]);
  });

  it('edits a profile to sign in with a key and deletes it with its secrets', async () => {
    await click('New SSH profile');
    await fill(fixture, 'SSH server', 'jump.test');
    await fill(fixture, 'User', 'ana');
    await fill(fixture, 'Password', 'pw');
    await click(/^Save$/);
    const id = api.documentsStore[0].id;
    expect(api.documentsStore[0].name).toBe('ana@jump.test');

    await click(/^Edit$/);
    expect(valueOf(root(), 'SSH server')).toBe('jump.test');
    expect(text()).toContain('Leave the secret blank to keep the stored one.');
    await fill(fixture, 'Sign in with', 'key');
    expect(text()).toContain('Paste the private key of the SSH profile');
    await fill(fixture, 'Private key (OpenSSH or PEM)', 'KEY');
    await fill(fixture, 'Passphrase of the key', 'phrase');
    await click(/^Save$/);
    expect(api.documentsStore[0].value).toMatchObject({
      auth: 'key',
      passphraseSecret: `ssh-${id}-passphrase`,
    });
    expect(api.secretNames).toEqual([`ssh-${id}`, `ssh-${id}-passphrase`]);
    expect(text()).toContain('Private key');

    await click(/^Edit$/);
    await click(/^Cancel$/);
    expect(text()).not.toContain('Edit SSH profile');

    state.confirm = () => false;
    await click(/^Delete$/);
    expect(api.documentsStore).toHaveLength(1);
    state.confirm = () => true;
    await click(/^Delete$/);
    expect(api.documentsStore).toHaveLength(0);
    expect(api.secretNames).toEqual([]);
    expect(state.toast()).toMatchObject({ title: 'SSH profile deleted' });
  });

  it('says why a profile could not be tested', async () => {
    await click('New SSH profile');
    await fill(fixture, 'SSH server', 'bastion.test');
    await fill(fixture, 'User', 'ana');
    await fill(fixture, 'Password', 'pw');
    await click(/^Save$/);
    api.responses['ssh.test'] = () => {
      throw new Error('The SSH server bastion.test:22 refused the user ana with that password');
    };
    await click(/^Test$/);
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('refused the user ana');
  });
});
