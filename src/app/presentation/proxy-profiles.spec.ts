import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('ProxyProfiles', () => {
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
    await click(/^Proxies$/);
  });

  it('creates, edits and deletes a profile, its password in the vault', async () => {
    expect(text()).toContain('No proxy profiles yet.');
    await click('New proxy profile');
    expect(text()).toContain('Enter the host of the proxy');
    expect((buttons(root(), /^Save$/)[0] as HTMLButtonElement).disabled).toBe(true);
    await fill(fixture, 'Name', 'Office');
    await fill(fixture, 'Proxy host', 'proxy.lan');
    await fill(fixture, 'Proxy user', 'ana');
    await fill(fixture, 'Proxy password', 'pw');
    await click(/^Save$/);
    const [saved] = api.documentsStore;
    expect(saved).toMatchObject({
      kind: 'proxy-profile',
      name: 'Office',
      value: { protocol: 'socks5', host: 'proxy.lan', username: 'ana', remoteDns: true },
    });
    expect(api.secretNames).toEqual([`proxy-${saved.id}`]);
    expect(state.toast()).toMatchObject({ title: 'Proxy profile saved', params: { v0: 'Office' } });
    expect(text()).toContain('proxy.lan:1080');

    // Without a user it keeps no password.
    await click(/^Edit$/);
    expect(text()).toContain('Leave the secret blank to keep the stored one.');
    await fill(fixture, 'Kind of proxy', 'http');
    await fill(fixture, 'Proxy user', '');
    await click(/^Save$/);
    expect(api.documentsStore[0].value).toEqual({ protocol: 'http', host: 'proxy.lan' });
    expect(api.secretNames).toEqual([]);
    expect(text()).toContain('proxy.lan:8080');

    await click(/^Edit$/);
    await click(/^Cancel$/);
    state.confirm = () => true;
    await click(/^Delete$/);
    expect(api.documentsStore).toEqual([]);
    expect(state.toast()).toMatchObject({ title: 'Proxy profile deleted' });
  });
});
