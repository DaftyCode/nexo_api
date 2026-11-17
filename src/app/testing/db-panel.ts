import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { DbPanel } from '../presentation/db-panel';
import { DbSection } from '../presentation/db-panel/section';
import { WorkspaceState } from '../presentation/workspace-state';
import { WorkspaceDocument } from '../domain/models';
import { buttons, clickButton, control, fill } from './controls';
import { FakeResponse, TEST_API, TestApi, testProviders } from './providers';

// The whole database section renders in each of these tests: more than a unit test takes,
// above all on a busy machine or a CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** The driver a test connects to, as `db.dialect` describes it. */
export function driverHello(options: {
  id?: string;
  name?: string;
  methods?: string[];
  explain?: string[];
  quote?: [string, string];
}) {
  const [quoteOpen, quoteClose] = options.quote ?? ['"', '"'];
  return {
    driver: { id: options.id ?? 'postgres', name: 'Driver', version: '1' },
    capabilities: {
      transactions: true,
      schemas: true,
      cancel: true,
      readOnlySessions: true,
      isolationLevels: ['read committed'],
      ...(options.explain ? { explain: options.explain } : {}),
      ...(options.methods ? { methods: options.methods } : {}),
    },
    dialect: {
      name: options.name ?? 'postgresql',
      quoteOpen,
      quoteClose,
      parameters: 'numbered',
      keywords: ['select', 'from'],
      functions: ['count'],
      types: ['integer', 'text'],
    },
  };
}

/** A module the tests take as installed. */
export function installedModule(id = 'postgres', name = 'PostgreSQL') {
  return {
    id,
    name,
    description: '',
    version: '0.7.0',
    state: 'installed',
    downloadSize: 1,
    size: 1,
    licenses: [],
    source: '',
    bundled: false,
  };
}

export function dbConnection(value: Record<string, unknown>, id = 'c1', name = 'Shop') {
  return {
    id,
    workspace_id: 'local',
    kind: 'connection',
    name,
    revision: 1,
    updated_at: 0,
    value,
  } as WorkspaceDocument;
}

/** A tree of nodes by path (`a/b`), as `db.tree` answers it. */
export type FakeTree = Record<string, unknown[]>;
export const node = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  kind,
  name,
  label: name,
  hasChildren: kind === 'folder' || kind === 'database' || kind === 'schema',
  actions: kind === 'table' || kind === 'view' ? ['open', 'data', 'ddl'] : [],
  ...extra,
});

/**
 * The database section in a test, on one saved connection, with a fake engine: what it
 * answers, what it was asked, and the clicks and keys a person would use.
 */
export async function startDbPanel(options: {
  responses?: Record<string, FakeResponse>;
  tree?: FakeTree;
  connection?: Record<string, unknown>;
  hello?: ReturnType<typeof driverHello>;
  modules?: unknown[];
  /** Tabs open from the start, the last one active. */
  tabs?: { id: string; kind: 'sql' | 'object' | 'console'; title: string; path?: string[] }[];
  /** Other documents of the workspace, saved before the section opens. */
  documents?: WorkspaceDocument[];
  /** The stored drafts of SQL tabs, by tab. */
  drafts?: Record<string, { text: string; cursor: number; script?: string; dirty?: boolean }>;
}) {
  const tree = options.tree ?? {};
  await TestBed.configureTestingModule({
    providers: testProviders({
      'modules.list': () => options.modules ?? [installedModule()],
      'db.connect': () => ({ serverVersion: '18', database: 'shop', tls: false }),
      'db.disconnect': () => ({}),
      'db.close': () => ({}),
      'db.dialect': () => options.hello ?? driverHello({}),
      'db.tree': (payload: Record<string, unknown>) => ({
        nodes: tree[(payload['path'] as string[]).join('/')] ?? [],
      }),
      'db.transaction': () => ({ autoCommit: true, open: false }),
      ...options.responses,
    }),
    imports: [DbPanel],
  }).compileComponents();
  const api: TestApi = TestBed.inject(TEST_API);
  const state = TestBed.inject(WorkspaceState);
  state.workspaceId.set('local');
  state.confirm = () => true;
  api.documentsStore.push(
    dbConnection(options.connection ?? { driver: 'postgres', host: 'db', database: 'shop' }),
    ...(options.documents ?? []),
  );
  await state.refresh();
  state.databaseSession.set({
    expanded: [],
    active: 'c1',
    bookmarks: [],
    simple: true,
    tabs: (options.tabs ?? []).map((tab) => ({ connection: 'c1', ...tab })),
    activeTab: options.tabs?.at(-1)?.id ?? '',
    drafts: Object.fromEntries(
      (options.tabs ?? [])
        .filter((tab) => tab.kind === 'sql')
        .map((tab) => [tab.id, options.drafts?.[tab.id] ?? { text: '', cursor: 0 }]),
    ),
  });
  const fixture: ComponentFixture<DbPanel> = TestBed.createComponent(DbPanel);
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i++) await fixture.whenStable();
  };
  await settle();
  const rowOf = (label: string) => {
    const found = [...root().querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (item) => item.querySelector('.db-label')?.textContent?.trim() === label,
    );
    if (!found) throw new Error(`No row ${label}`);
    return found;
  };
  const panel = {
    fixture,
    api,
    state,
    section: () => fixture.debugElement.injector.get(DbSection),
    root,
    text: () => root().textContent ?? '',
    settle,
    calls: (operation: string) =>
      api.calls.filter((call) => call.operation === operation).map((call) => call.payload),
    row: rowOf,
    rows: () =>
      [...root().querySelectorAll<HTMLElement>('[role="treeitem"]')].map((item) =>
        item.querySelector('.db-label')?.textContent?.trim(),
      ),
    /** Opens a row of the tree as a click on it does. */
    async open(...labels: string[]) {
      for (const label of labels) {
        rowOf(label).dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
        await settle();
      }
    },
    /** Chooses an entry of a row's menu (Shift+F10). */
    async menu(label: string, entry: string | RegExp) {
      rowOf(label).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      );
      await settle();
      const menu = root().querySelector<HTMLElement>('[role="menu"]');
      if (!menu) throw new Error(`No menu on ${label}`);
      await clickButton(fixture, entry, menu);
      await settle();
    },
    /** The entries of a row's menu, closed again. */
    async menuEntries(label: string) {
      rowOf(label).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      );
      await settle();
      const entries = [...root().querySelectorAll('[role="menu"] [role="menuitem"]')].map(
        (item) => item.textContent?.trim() ?? '',
      );
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      root()
        .querySelector('[role="menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      return entries;
    },
    async click(text: string | RegExp, within?: Element) {
      await clickButton(fixture, text, within ?? root());
      await settle();
    },
    async fill(label: string, value: string, within?: Element) {
      await fill(fixture, label, value, within ?? root());
      await settle();
    },
    control: (label: string, within?: Element) => control(within ?? root(), label),
    buttons: (text: string | RegExp, within?: Element) => buttons(within ?? root(), text),
    dialog(name?: string | RegExp) {
      const all = [...root().querySelectorAll<HTMLElement>('[role="dialog"]')];
      const found = name
        ? all.find((dialog) => {
            const title = dialog.getAttribute('aria-labelledby');
            const heading = title ? (root().querySelector(`#${title}`)?.textContent ?? '') : '';
            const label = dialog.getAttribute('aria-label') ?? heading;
            return typeof name === 'string' ? label.includes(name) : name.test(label);
          })
        : all.at(-1);
      if (!found) throw new Error(`No dialog ${String(name ?? '')}`);
      return found;
    },
  };
  return panel;
}
export type DbPanelTest = Awaited<ReturnType<typeof startDbPanel>>;
