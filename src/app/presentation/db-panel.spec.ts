import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, fill } from '../testing/controls';
import { ModuleSummary } from '../domain/modules';
import { DbPanel } from './db-panel';
import { WorkspaceState } from './workspace-state';

const postgres: ModuleSummary = {
  id: 'postgres',
  name: 'PostgreSQL',
  description: 'PostgreSQL and compatible servers',
  version: '0.7.0',
  state: 'installed',
  downloadSize: 2_000_000,
  size: 5_000_000,
  licenses: ['MIT'],
  source: 'https://github.com/o/r/releases/download/v0.7.0/postgres.gz',
  bundled: false,
};

const tree: Record<string, unknown[]> = {
  '': [{ kind: 'database', name: 'shop', label: 'shop', hasChildren: true, actions: ['open'] }],
  shop: [
    { kind: 'folder', name: 'schemas', label: 'Schemas', hasChildren: true, actions: [] },
    { kind: 'folder', name: 'roles', label: 'Roles', hasChildren: true, actions: [], system: true },
  ],
  'shop/schemas': [
    { kind: 'schema', name: 'public', label: 'public', hasChildren: true, actions: ['ddl'] },
    { kind: 'schema', name: 'archive', label: 'archive', hasChildren: true, actions: ['ddl'] },
  ],
};

describe('DbPanel', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 8; i++) await fixture.whenStable();
  };
  const operations = () => api.calls.map((call) => call.operation);
  const rows = () =>
    [...root().querySelectorAll<HTMLElement>('[role="treeitem"]')].map((row) =>
      row.querySelector('.db-label')?.textContent?.trim(),
    );
  const row = (label: string) =>
    [...root().querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (item) => item.querySelector('.db-label')?.textContent?.trim() === label,
    )!;
  const press = async (target: HTMLElement, key: string, shiftKey = false) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [postgres],
        'db.test': () => ({
          server: { serverVersion: '18.1', product: 'PostgreSQL', user: 'ana', tls: false },
          pingMs: 4,
        }),
        'db.connect': () => ({ serverVersion: '18.1', tls: false }),
        'db.tree': (payload: Record<string, unknown>) => ({
          nodes: tree[(payload['path'] as string[]).join('/')] ?? [],
        }),
        'db.dialect': () => ({ dialect: { quoteOpen: '"', quoteClose: '"', keywords: [] } }),
        'db.disconnect': () => ({}),
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.confirm = () => true;
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  });

  async function create() {
    await clickButton(fixture, '＋ New connection');
    await settle();
    await clickButton(fixture, 'PostgreSQL');
    await settle();
    await fill(fixture, 'Paste a connection URL', 'postgresql://ana:secret@db.test:5433/shop');
    await clickButton(fixture, 'Use URL');
    await settle();
    await fill(fixture, 'Connection name', 'Shop');
  }

  it('creates a connection from a URL, tests it and saves it without its password', async () => {
    expect(text()).toContain('No database connections yet.');
    await create();
    expect(text()).toContain('The password left the URL');
    expect(text()).toContain('postgresql://ana@db.test:5433/shop');
    await clickButton(fixture, 'Test connection');
    await settle();
    const tested = api.calls.find((call) => call.operation === 'db.test')!.payload;
    expect(tested['connection']).toEqual(
      expect.objectContaining({ password: expect.stringMatching(/^\{\{vault:db-password:/) }),
    );
    expect(text()).toContain('PostgreSQL 18.1');
    await clickButton(fixture, 'Save');
    await settle();
    const saved = api.documentsStore.find((document) => document.kind === 'connection')!;
    expect(saved.name).toBe('Shop');
    expect(JSON.stringify(saved.value)).not.toContain('secret');
    expect(api.secretNames).toEqual([`db-password:${saved.id}`]);
    expect(rows()).toEqual(['Shop']);
  });

  it('connects when a connection is expanded and browses it with the keyboard', async () => {
    await create();
    await clickButton(fixture, 'Save');
    await settle();
    const shop = row('Shop');
    shop.click();
    await press(shop, 'ArrowRight');
    expect(operations()).toContain('db.connect');
    expect(api.calls.find((call) => call.operation === 'db.connect')!.payload['session']).toMatch(
      /^tree:/,
    );
    expect(rows()).toEqual(['Shop', 'shop']);
    await press(row('Shop'), 'ArrowDown');
    await press(row('shop'), 'Enter');
    // The simple view hides administration folders.
    expect(rows()).toEqual(['Shop', 'shop', 'Schemas']);
    await clickButton(fixture, 'Show system objects');
    expect(rows()).toContain('Roles');
    await press(row('shop'), 'ArrowDown');
    await press(row('Schemas'), 'ArrowRight');
    expect(rows()).toContain('archive');

    // The text filter keeps what matches and the nodes that lead to it.
    await fill(fixture, 'Filter loaded objects', 'arch');
    expect(rows()).toEqual(['Shop', 'shop', 'Schemas', 'archive']);
    await fill(fixture, 'Filter loaded objects', '');

    // F5 asks the tree again.
    const before = operations().filter((operation) => operation === 'db.tree').length;
    await press(row('Schemas'), 'F5');
    expect(operations().filter((operation) => operation === 'db.tree').length).toBe(before + 1);

    // The actions menu opens with Shift+F10; a bookmark is listed above the tree.
    await press(row('archive'), 'F10', true);
    expect(root().querySelector('[role="menu"]')?.textContent).toContain('Copy DDL');
    await clickButton(fixture, 'Bookmark', root().querySelector('[role="menu"]')!);
    expect(root().querySelector('.db-bookmarks')?.textContent).toContain('archive');
    expect(state.databaseSession()?.bookmarks).toEqual([
      expect.objectContaining({ label: 'archive', path: ['shop', 'schemas', 'archive'] }),
    ]);
  });

  it('deletes a connection only once its name is typed', async () => {
    await create();
    await clickButton(fixture, 'Save');
    await settle();
    await press(row('Shop'), 'Delete');
    const dialog = root().querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Type Shop to confirm');
    const confirm = buttons(dialog, 'Delete')[0];
    confirm.click();
    await settle();
    expect(api.documentsStore.some((document) => document.kind === 'connection')).toBe(true);
    const typed = [...dialog.querySelectorAll('input')].at(-1)!;
    typed.value = 'Shop';
    typed.dispatchEvent(new Event('input'));
    await settle();
    buttons(dialog, 'Delete')[0].click();
    await settle();
    expect(api.documentsStore.some((document) => document.kind === 'connection')).toBe(false);
    expect(api.secretNames).toEqual([]);
    expect(rows()).toEqual([]);
  });
});
