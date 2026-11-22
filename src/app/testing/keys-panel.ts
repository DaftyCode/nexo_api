/**
 * The database panel with a Redis connection whose keys tab is open, and a fake server that
 * answers its keys, values, changes and commands (DB-35).
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from '../presentation/db-panel';
import { WorkspaceState } from '../presentation/workspace-state';
import { TEST_API, TestApi, testProviders } from './providers';

const module = {
  id: 'redis',
  name: 'Redis and Valkey',
  description: '',
  version: '0.10.0',
  state: 'installed',
  downloadSize: 1,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
};
const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Cache',
  revision: 1,
  updated_at: 0,
  value: { driver: 'redis', host: 'localhost', database: '0' },
};
/** The keys of the fake server, with their values. */
export const VALUES: Record<string, unknown> = {
  'user:1:name': { key: 'user:1:name', type: 'string', value: 'Ana', elements: [], ttlMs: 5000 },
  bin: { key: 'bin', type: 'string', value: { $t: 'binary', v: '/wA=' }, elements: [] },
  'user:1': {
    key: 'user:1',
    type: 'hash',
    length: 2,
    size: 80,
    encoding: 'listpack',
    elements: [
      { field: 'name', value: 'Ana' },
      { field: 'city', value: 'Lima' },
    ],
    cursor: '7',
  },
  scores: { key: 'scores', type: 'zset', elements: [{ value: 'ana', score: 1.5 }] },
  queue: { key: 'queue', type: 'list', elements: [{ index: 0, value: 'a' }] },
  events: { key: 'events', type: 'stream', elements: [{ id: '1-0', value: '{"a":"1"}' }] },
  bloom: { key: 'bloom', type: 'MBbloom--', elements: [] },
};

function command(payload: Record<string, unknown>) {
  const line = String(payload['line']);
  if (line === 'FLUSHDB' && payload['confirmName'] !== 'FLUSHDB')
    throw new Error('Type FLUSHDB to confirm it');
  if (line === 'INFO') return { reply: '# Server\r\nredis_version:7.4.1', elapsedMs: 1 };
  if (line === 'CLIENT LIST')
    return { reply: 'id=3 addr=127.0.0.1:5 name= cmd=client', elapsedMs: 1 };
  if (line.startsWith('SLOWLOG')) return { reply: [[1, 2, 3, ['KEYS', '*']]], elapsedMs: 1 };
  if (line === 'BAD') return { reply: { error: 'ERR unknown command' }, elapsedMs: 1 };
  return { reply: 'OK', elapsedMs: 1 };
}

function scan(payload: Record<string, unknown>) {
  if (payload['cursor']) return { keys: [{ key: 'z:last', type: 'string' }], cursor: null };
  return {
    keys: Object.entries(VALUES).map(([key, value]) => ({
      key,
      type: (value as { type: string }).type,
      ttlMs: key === 'user:1:name' ? 5000 : null,
    })),
    cursor: '42',
  };
}

export interface KeysPanel {
  fixture: ComponentFixture<DbPanel>;
  api: TestApi;
  root: () => HTMLElement;
  settle: () => Promise<void>;
  calls: (operation: string) => Record<string, unknown>[];
  type: (input: HTMLInputElement | HTMLTextAreaElement, text: string) => Promise<void>;
  pick: (select: HTMLSelectElement, value: string) => Promise<void>;
  row: (label: string) => HTMLButtonElement;
  open: (label: string) => Promise<void>;
}

/** Opens the panel on the keys of db0. */
export async function keysPanel(): Promise<KeysPanel> {
  await TestBed.configureTestingModule({
    providers: testProviders({
      'modules.list': () => [module],
      'db.connect': () => ({ serverVersion: '7.4.1', database: 'db0', tls: false }),
      'db.dialect': () => ({
        driver: { id: 'redis', name: 'Redis and Valkey', version: '1' },
        capabilities: { extensions: ['keyvalue'] },
        dialect: { name: 'redis', quoteOpen: '"', quoteClose: '"' },
      }),
      'db.kv.scan': scan,
      'db.kv.get': (payload: Record<string, unknown>) => {
        const value = VALUES[String(payload['key'])] as { elements: unknown[] };
        return payload['cursor'] ? { ...value, elements: [{ field: 'zip', value: '1' }] } : value;
      },
      'db.kv.write': (payload: Record<string, unknown>) => ({
        key: payload['to'] ?? payload['key'],
        done: true,
      }),
      'db.kv.command': command,
    }),
    imports: [DbPanel],
  }).compileComponents();
  const api = TestBed.inject(TEST_API);
  const state = TestBed.inject(WorkspaceState);
  state.workspaceId.set('local');
  api.documentsStore.push(connection);
  await state.refresh();
  state.databaseSession.set({
    expanded: [],
    active: 'c1',
    bookmarks: [],
    simple: true,
    tabs: [{ id: 'k1', kind: 'keys', connection: 'c1', title: 'db0', path: ['db0'] }],
    activeTab: 'k1',
    drafts: {},
  });
  const fixture = TestBed.createComponent(DbPanel);
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((done) => setTimeout(done));
    }
  };
  const row = (label: string) =>
    [...root().querySelectorAll<HTMLButtonElement>('.db-keys-row')].find((button) =>
      button.textContent?.includes(label),
    )!;
  const panel: KeysPanel = {
    fixture,
    api,
    root,
    settle,
    calls: (operation) =>
      api.calls.filter((call) => call.operation === operation).map((call) => call.payload),
    type: async (input, text) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await settle();
    },
    pick: async (select, value) => {
      select.value = value;
      select.dispatchEvent(new Event('input'));
      select.dispatchEvent(new Event('change'));
      await settle();
    },
    row,
    open: async (label) => {
      row(label).click();
      await settle();
    },
  };
  await settle();
  return panel;
}
