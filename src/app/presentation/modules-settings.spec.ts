import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton } from '../testing/controls';
import { ModuleSummary } from '../domain/modules';
import { ModulesSettings } from './modules-settings';
import { WorkspaceState } from './workspace-state';

const module = (id: string, name: string, state: ModuleSummary['state']): ModuleSummary => ({
  id,
  name,
  description: `The ${name} driver`,
  version: '0.7.0',
  state,
  downloadSize: 3 * 1024 * 1024,
  size: 8 * 1024 * 1024,
  licenses: ['MIT', 'Apache-2.0'],
  source: 'https://github.com/DaftyCode/nexo_api/releases/download/v0.7.0/postgres.gz',
  bundled: false,
});

describe('ModulesSettings', () => {
  let fixture: ComponentFixture<ModulesSettings>;
  let api: TestApi;
  let state: WorkspaceState;
  let modules: ModuleSummary[];
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
  };
  const operations = () => api.calls.map((call) => call.operation);

  beforeEach(async () => {
    modules = [
      module('postgres', 'PostgreSQL', 'available'),
      module('mssql', 'SQL Server', 'outdated'),
      module('test', 'test', 'development'),
    ];
    let progress = 0;
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => modules,
        'modules.install': (payload: Record<string, unknown>) => {
          if (payload['id'] === 'mssql') throw new Error('unused');
          return { id: payload['id'], state: 'downloading', received: 0, total: 100 };
        },
        'modules.progress': (payload: Record<string, unknown>) => {
          progress += 50;
          if (progress < 100)
            return { id: payload['id'], state: 'downloading', received: progress, total: 100 };
          modules = modules.map((m) => (m.id === payload['id'] ? { ...m, state: 'installed' } : m));
          return { id: payload['id'], state: 'installed', received: 100, total: 100 };
        },
        'modules.remove': (payload: Record<string, unknown>) => {
          modules = modules.map((m) => (m.id === payload['id'] ? { ...m, state: 'available' } : m));
          return {};
        },
      }),
      imports: [ModulesSettings],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    fixture = TestBed.createComponent(ModulesSettings);
    await settle();
  });

  it('lists the modules with their state and what they weigh', () => {
    const text = root().textContent ?? '';
    for (const expected of ['PostgreSQL', 'Not installed', 'SQL Server', 'Needs an update'])
      expect(text).toContain(expected);
    expect(text).toContain('Version 0.7.0 · 3.0 MB to download');
    expect(text).toContain('Built from the sources');
    expect(buttons(root(), 'Install PostgreSQL')).toHaveLength(1);
    expect(buttons(root(), 'Update SQL Server')).toHaveLength(1);
    // A development build is not removed from Nexo.
    expect(buttons(root(), 'Remove test')).toHaveLength(0);
  });

  it('asks before downloading, follows the download and announces it', async () => {
    await clickButton(fixture, 'Install PostgreSQL');
    const dialog = root().querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Download the PostgreSQL module');
    expect(dialog.textContent).toContain('3.0 MB');
    expect(dialog.textContent).toContain('github.com, version 0.7.0');
    expect(dialog.textContent).toContain('MIT · Apache-2.0');
    expect(operations()).not.toContain('modules.install');

    await clickButton(fixture, 'Download', dialog);
    await settle();
    expect(operations().filter((o) => o === 'modules.progress').length).toBeGreaterThan(0);
    expect(root().querySelector('[role="dialog"]')).toBeNull();
    expect(state.toast()?.title).toBe('Module installed');
    expect(root().textContent).toContain('Installed');
  });

  it('closes the dialog without downloading', async () => {
    await clickButton(fixture, 'Install PostgreSQL');
    await clickButton(fixture, 'Cancel', root().querySelector('[role="dialog"]')!);
    expect(root().querySelector('[role="dialog"]')).toBeNull();
    expect(operations()).not.toContain('modules.install');
  });

  it('says how many saved connections a removal leaves without their driver', async () => {
    const asked: string[] = [];
    state.confirm = (message) => (asked.push(message), true);
    state.documents.set([
      {
        id: 'c1',
        workspace_id: 'local',
        kind: 'connection',
        name: 'Orders',
        revision: 1,
        updated_at: 0,
        value: { driver: 'mssql' },
      },
    ]);
    await clickButton(fixture, 'Remove SQL Server');
    await settle();
    expect(asked[0]).toContain('1 saved connections use it');
    expect(api.calls.find((c) => c.operation === 'modules.remove')?.payload).toEqual({
      id: 'mssql',
    });
    expect(state.toast()?.title).toBe('Module removed');
  });

  it('keeps the choice of updating modules by themselves', async () => {
    const box = root().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    box.click();
    await settle();
    const again = TestBed.createComponent(ModulesSettings);
    await again.whenStable();
    const remembered = (again.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(remembered.checked).toBe(true);
  });
});
