import { ComponentFixture, TestBed } from '@angular/core/testing';
import { fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { emptyRoute } from '../domain/route';
import { RoutePicker } from './route-picker';
import { WorkspaceState } from './workspace-state';

describe('RoutePicker', () => {
  let fixture: ComponentFixture<RoutePicker>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const ways = () => [...root().querySelector('select')!.options].map((option) => option.value);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [RoutePicker],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(RoutePicker);
    await fixture.whenStable();
  });

  it('offers inheriting and HTTP proxies only where they work', async () => {
    expect(ways()).toEqual(['direct', 'http', 'socks5', 'ssh']);
    fixture.componentRef.setInput('inheritable', true);
    fixture.componentRef.setInput('allowHttp', false);
    await fixture.whenStable();
    expect(ways()).toEqual(['inherit', 'direct', 'socks5', 'ssh']);
    // A stored way stays visible even where it is not offered.
    fixture.componentRef.setInput('inheritable', false);
    fixture.componentRef.setInput('route', { ...emptyRoute(), via: 'http', host: 'p' });
    await fixture.whenStable();
    expect(ways()).toEqual(['direct', 'http', 'socks5', 'ssh']);
  });

  it('edits a SOCKS5 proxy with the fields it needs', async () => {
    await fill(fixture, 'Connect through', 'socks5');
    expect(text()).toContain('Enter the host of the proxy');
    await fill(fixture, 'Proxy host', 'proxy.test');
    await fill(fixture, 'Proxy port', '99999');
    expect(text()).toContain('Invalid proxy port');
    await fill(fixture, 'Proxy port', '1080');
    await fill(fixture, 'Proxy user', 'ada');
    await fill(fixture, 'Proxy password', 'pw');
    const box = root().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    box.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.route()).toEqual({
      ...emptyRoute(),
      via: 'socks5',
      host: 'proxy.test',
      port: '1080',
      username: 'ada',
      password: 'pw',
      remoteDns: false,
    });
    expect(text()).not.toContain('Invalid proxy port');
  });

  it('chooses an SSH profile, or says where to create one', async () => {
    await fill(fixture, 'Connect through', 'ssh');
    expect(text()).toContain('Create SSH profiles in Settings → SSH.');
    expect(text()).toContain('Choose the SSH profile to connect through');
    await api.save({
      id: 'p1',
      workspace_id: 'local',
      kind: 'ssh-profile',
      name: 'Bastion',
      revision: 0,
      updated_at: 0,
      value: { host: 'bastion', username: 'ana', auth: 'password', secret: 'ssh-p1' },
    });
    await state.refresh();
    await fixture.whenStable();
    expect(text()).not.toContain('Create SSH profiles');
    await fill(fixture, 'SSH profile', 'p1');
    expect(fixture.componentInstance.route()).toMatchObject({ via: 'ssh', profile: 'p1' });
    expect(text()).not.toContain('Choose the SSH profile');
  });
});
