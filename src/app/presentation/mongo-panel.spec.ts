import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import {
  buttons,
  clickButton,
  exerciseControls,
  fill,
  renderDeferred,
  valueOf,
} from '../testing/controls';
import { MongoPanel } from './mongo-panel';
import { WorkspaceState } from './workspace-state';
import { mongoReport as report } from '../testing/mongo-report';

describe('MongoPanel', () => {
  let fixture: ComponentFixture<MongoPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp) => {
    await clickButton(fixture, label);
    await settle();
  };
  const uri = () => root().querySelector('[data-testid="mongo-uri"]')?.textContent?.trim();
  const tab = (name: string) => click(new RegExp(`^${name}$`));
  /** Picks an authentication choice. */
  const choose = async (value: string) => {
    const select = root().querySelector<HTMLSelectElement>('select')!;
    select.value = value;
    select.dispatchEvent(new Event('input'));
    select.dispatchEvent(new Event('change'));
    await settle();
  };
  const tick = async (label: string) => {
    const box = [...root().querySelectorAll('label')]
      .find((l) => l.textContent?.trim().startsWith(label))
      ?.querySelector('input') as HTMLInputElement;
    box.click();
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [MongoPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(MongoPanel);
    await settle();
  });

  /** What the form told its tab: saved, explore or removed. */
  const outputs = () => {
    const told: string[] = [];
    const form = fixture.componentInstance;
    form.saved.subscribe((document) => told.push(`saved ${document.name}`));
    form.explore.subscribe((document) => told.push(`explore ${document.name}`));
    form.removed.subscribe(() => told.push('removed'));
    return told;
  };
  /** The connection the form edits: a saved one, or none for a new one. */
  const edit = async (id: string) => {
    fixture.componentRef.setInput('connectionId', id);
    await settle();
  };

  it('moves a pasted password to the vault and saves the connection without it', async () => {
    expect(text()).toContain('Import from MongoDB Compass');
    const emitted = outputs();
    await fill(
      fixture,
      'Paste a connection string',
      'mongodb+srv://ana:s3cret@cluster0.example.net/app',
    );
    await click('Use URI');
    expect(text()).toContain('The password left the URI');
    expect(uri()).toBe('mongodb+srv://ana@cluster0.example.net/app');
    await fill(fixture, 'Connection name', 'Atlas');
    await fill(fixture, 'Folder', 'Cloud');
    await click('Color 3');
    await tick('Read-only');
    await click('Save connection');
    expect(api.secretNames).toEqual([expect.stringMatching(/^mongo-password:/)]);
    const [saved] = api.documentsStore;
    expect(saved).toMatchObject({
      kind: 'connection',
      name: 'Atlas',
      value: {
        uri: 'mongodb+srv://ana@cluster0.example.net/app',
        folder: 'Cloud',
        color: '#57ab5a',
        readOnly: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain('s3cret');
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Connection saved',
      params: { v0: 'Atlas' },
    });
    expect(emitted).toEqual(['saved Atlas']);
    expect(text()).not.toContain('Import from MongoDB Compass');
    await tab('Authentication');
    const password = root().querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(password.value).toBe('');
    expect(password.placeholder).toContain('Saved in the vault');
  });

  it('builds the URI field by field and refuses forms that cannot work', async () => {
    await fill(fixture, 'Hosts', 'db1.test:27017\ndb2.test:27017');
    await fill(fixture, 'Replica set', 'rs0');
    await tab('Authentication');
    await choose('SCRAM-SHA-256');
    expect(text()).toContain('Add the user name');
    expect(buttons(root(), 'Test connection')[0].disabled).toBe(true);
    await fill(fixture, 'Username', 'ana');
    await fill(fixture, 'Authentication database', 'admin');
    await tab('TLS');
    await tick('Use TLS');
    await tick('Allow invalid certificates');
    expect(text()).toContain('Any certificate is accepted');
    await tab('Options');
    await fill(fixture, 'Write concern (w)', 'majority');
    await tick('Retry writes');
    await fill(fixture, 'Other URI options', 'appName=reports');
    expect(uri()).toBe(
      'mongodb://ana@db1.test:27017,db2.test:27017/?replicaSet=rs0&authMechanism=SCRAM-SHA-256' +
        '&authSource=admin&tls=true&tlsAllowInvalidCertificates=true&w=majority&retryWrites=false' +
        '&appName=reports',
    );
  });

  it('reaches the servers through a SOCKS5 proxy, never an HTTP one', async () => {
    await tab('Connect through');
    const via = [...root().querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'socks5'),
    )!;
    expect([...via.options].map((option) => option.value)).toEqual(['direct', 'socks5', 'ssh']);
    expect(text()).toContain('MongoDB goes through SOCKS5 proxies and SSH tunnels');
    await fill(fixture, 'Connect through', 'socks5');
    expect(text()).toContain('Enter the host of the proxy');
    await fill(fixture, 'Proxy host', 'proxy.test');
    await fill(fixture, 'Proxy port', '1080');
    api.responses['mongo.test'] = report;
    await click('Test connection');
    const route = { via: 'socks5', host: 'proxy.test', port: '1080', remoteDns: true };
    const call = api.calls.find((c) => c.operation === 'mongo.test')!;
    expect(call.payload['connection']).toEqual({ uri: 'mongodb://localhost:27017/', route });
    await click('Save connection');
    expect(api.documentsStore[0].value).toMatchObject({ nexoRoute: route });
    await edit('another');
    expect(valueOf(root(), 'Connection name')).toBe('Local MongoDB');
    await edit(api.documentsStore[0].id);
    await tab('Connect through');
    expect(valueOf(root(), 'Proxy host')).toBe('proxy.test');
  });

  it('tests a connection and shows each server with the egress policy', async () => {
    api.responses['mongo.test'] = report;
    await tab('Authentication');
    await choose('default');
    await fill(fixture, 'Username', 'ana');
    await fill(fixture, 'Password', 'typed-password');
    await click('Test connection');
    const call = api.calls.find((c) => c.operation === 'mongo.test')!;
    expect(call.payload).toEqual({
      workspace: 'local',
      connection: { uri: 'mongodb://ana@localhost:27017/', password: 'typed-password' },
    });
    expect(api.secretNames, 'testing saves nothing').toEqual([]);
    expect(text()).toContain('8.0.4');
    expect(text()).toContain('Replica set · rs0');
    expect(text()).toContain('Connected to the first server only');
    expect(text()).toContain('Destination 10.0.0.5 is blocked by the egress policy');
    expect(text()).toContain('Primary');

    api.responses['mongo.test'] = () => {
      throw new Error('Authentication failed: check the user');
    };
    await click('Test connection');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Authentication failed');
    expect(text()).not.toContain('8.0.4');
  });

  it('opens, copies, deletes and imports connections', async () => {
    await api.save({
      id: 'c1',
      workspace_id: 'local',
      kind: 'connection',
      name: 'Local',
      revision: 0,
      updated_at: 0,
      value: {
        uri: 'mongodb://ana@localhost:27117/?authSource=admin',
        password: '{{vault:mongo-password:c1}}',
      },
    });
    api.secretNames.push('mongo-password:c1');
    await state.refresh();
    await edit('c1');
    expect(valueOf(root(), 'Connection name')).toBe('Local');
    expect(uri()).toBe('mongodb://ana@localhost:27117/?authSource=admin');

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => void copied.push(value) },
    });
    await click('Copy URI');
    expect(copied).toEqual(['mongodb://ana@localhost:27117/?authSource=admin']);

    const asked = outputs();
    await click('Browse data');
    expect(asked).toEqual(['explore Local']);

    state.confirm = () => false;
    await click('Delete connection');
    expect(api.documentsStore).toHaveLength(1);
    state.confirm = () => true;
    await click('Delete connection');
    expect(api.documentsStore).toHaveLength(0);
    expect(asked).toEqual(['explore Local', 'removed']);
    expect(api.secretNames).toEqual([]);
    expect(state.toast()).toMatchObject({ title: 'Connection deleted', params: { v0: 'Local' } });

    const file = new File(
      [
        JSON.stringify({
          type: 'Compass Connections',
          connections: [{ connectionOptions: { connectionString: 'mongodb://h1/' } }],
        }),
      ],
      'compass.json',
    );
    const input = root().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await settle();
    await settle();
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Import completed',
      message: 'mongo.imported',
      params: { v0: '1' },
    });
    expect(api.documentsStore.map((d) => d.name)).toEqual(['Connection 1']);
  });

  it('exposes a connection to MCP agents with the fields they never see', async () => {
    await fill(fixture, 'Paste a connection string', 'mongodb://db.test:27017/app');
    await click('Use URI');
    await fill(fixture, 'Connection name', 'Shop');
    expect(text()).not.toContain('Fields hidden from MCP agents');
    await tick('Let MCP agents read it');
    await fill(fixture, 'Fields hidden from MCP agents', 'email, address.phone, ');
    await click('Save connection');
    expect(api.documentsStore[0].value).toMatchObject({
      mcp: true,
      mcpHidden: ['email', 'address.phone'],
    });
  });

  it('every control reaches the form', async () => {
    const tabs = ['Server', 'Authentication', 'TLS', 'Options'];
    const unchanged: string[] = [];
    for (const name of tabs) {
      await tab(name);
      // Turn on what reveals more controls first.
      if (name === 'Authentication') await choose('default');
      if (name === 'TLS') await tick('Use TLS');
      await settle();
      unchanged.push(
        ...(await exerciseControls(fixture, () => fixture.componentInstance['model'](), {
          skip: (control) =>
            (control as HTMLInputElement).type === 'file' ||
            // Its value fills the form only when "Use URI" is pressed.
            control.getAttribute('placeholder')?.startsWith('mongodb+srv://user') === true,
        })),
      );
    }
    expect(unchanged).toEqual([]);
  });
});
