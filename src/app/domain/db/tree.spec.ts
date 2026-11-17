import { isMongoConnection } from '../mongo';
import { isDbConnection, withFilter } from './connection';
import { navigatorRows, NavigatorSnapshot } from './rows';
import {
  DbNode,
  copiedName,
  filtered,
  keyPath,
  matchesPatterns,
  nodeKey,
  toggleBookmark,
} from './tree';
import { readDatabaseSession, storedDrafts } from './session';

const node = (name: string, extra: Partial<DbNode> = {}): DbNode => ({
  kind: 'table',
  name,
  label: name,
  hasChildren: false,
  actions: [],
  ...extra,
});

function snapshot(change: Partial<NavigatorSnapshot> = {}): NavigatorSnapshot {
  const connections = [
    { id: 'a', name: 'Shop', value: { driver: 'postgres', host: 'db', type: 'production' } },
    { id: 'b', name: 'Local', value: { driver: 'postgres', host: 'localhost', folder: 'Dev' } },
  ];
  return {
    connections,
    folders: [
      { folder: '', connections: [{ id: 'a' }] },
      { folder: 'Dev', connections: [{ id: 'b' }] },
    ],
    expanded: new Set([nodeKey('a', []), nodeKey('a', ['shop'])]),
    closedFolders: new Set(),
    children: new Map([
      [nodeKey('a', []), [node('shop', { kind: 'database', hasChildren: true })]],
      [
        nodeKey('a', ['shop']),
        [
          node('orders'),
          node('customers'),
          node('pg_catalog', { kind: 'schema', system: true, hasChildren: true }),
        ],
      ],
    ]),
    loading: new Set(),
    errors: new Map(),
    status: { a: 'connected' },
    simple: true,
    text: '',
    ...change,
  };
}

const labels = (snap: NavigatorSnapshot) => navigatorRows(snap).map((row) => row.label);

describe('the database navigator', () => {
  it('draws folders, connections and the loaded nodes, hiding system objects', () => {
    const rows = navigatorRows(snapshot());
    expect(rows.map((row) => [row.type, row.label, row.level])).toEqual([
      ['connection', 'Shop', 1],
      ['node', 'shop', 2],
      ['node', 'orders', 3],
      ['node', 'customers', 3],
      ['folder', 'Dev', 1],
      ['connection', 'Local', 2],
    ]);
    expect(rows[0]).toEqual(
      expect.objectContaining({ kind: 'production', status: 'connected', expanded: true }),
    );
    expect(labels(snapshot({ simple: false }))).toContain('pg_catalog');
  });

  it('shows a connection closed until it is connected, and folders folded', () => {
    expect(labels(snapshot({ status: {} }))).toEqual(['Shop', 'Dev', 'Local']);
    expect(labels(snapshot({ closedFolders: new Set(['folder:Dev']) }))).not.toContain('Local');
  });

  it('filters by text what is loaded, with the nodes that lead to it', () => {
    expect(labels(snapshot({ text: 'cust' }))).toEqual(['Shop', 'shop', 'customers']);
    expect(labels(snapshot({ text: 'loc' }))).toEqual(['Dev', 'Local']);
  });

  it('says when a node is loading, failed or is empty', () => {
    const key = nodeKey('a', ['shop']);
    expect(navigatorRows(snapshot({ loading: new Set([key]) }))[2].type).toBe('loading');
    const failed = navigatorRows(snapshot({ errors: new Map([[key, 'denied']]) }));
    expect(failed[2]).toEqual(expect.objectContaining({ type: 'error', label: 'denied' }));
    const children = new Map(snapshot().children);
    children.set(key, []);
    expect(navigatorRows(snapshot({ children }))[2].type).toBe('empty');
  });

  it('applies the include and exclude filters kept in the connection', () => {
    const value = {
      driver: 'postgres',
      filters: withFilter({ driver: 'postgres' }, ['shop'], '', 'cust*'),
    };
    const connections = [{ ...snapshot().connections[0], value }];
    expect(labels(snapshot({ connections }))).not.toContain('customers');
    expect(
      filtered([node('a'), node('b'), node('x', { kind: 'folder' })], { path: [], include: 'a' }),
    ).toEqual([node('a'), node('x', { kind: 'folder' })]);
  });

  it('matches patterns as DBeaver does', () => {
    expect(matchesPatterns('Orders_2026', 'orders_*')).toBe(true);
    expect(matchesPatterns('orders', 'ord%')).toBe(true);
    expect(matchesPatterns('t1', 'x, t?')).toBe(true);
    expect(matchesPatterns('a.b', 'a?b')).toBe(true);
    expect(matchesPatterns('ab', 'a.b')).toBe(false);
  });

  it('copies names quoted as the engine needs them', () => {
    const style = { quoteOpen: '"', quoteClose: '"', keywords: ['SELECT'] };
    expect(copiedName(node('orders'), style)).toBe('orders');
    expect(copiedName(node('Order Lines'), style)).toBe('"Order Lines"');
    expect(copiedName(node('select'), style)).toBe('"select"');
    expect(copiedName(node('say"hi'), style)).toBe('"say""hi"');
    const routine = node('1234', { kind: 'function', label: 'Count(x integer)' });
    expect(copiedName(routine, style)).toBe('"Count"(x integer)');
    expect(copiedName(node('t'), { quoteOpen: '[', quoteClose: ']' })).toBe('t');
  });

  it('tells the connections of the modules from those of MongoDB', () => {
    const sql = { kind: 'connection', value: { driver: 'postgres' } };
    const mongo = { kind: 'connection', value: { uri: 'mongodb://h' } };
    const named = { kind: 'connection', value: { driver: 'mongodb', uri: 'mongodb://h' } };
    expect([sql, mongo, named].map(isDbConnection)).toEqual([true, false, false]);
    expect([sql, mongo, named].map(isMongoConnection)).toEqual([false, true, true]);
    expect(isDbConnection({ kind: 'collection', value: { driver: 'postgres' } })).toBe(false);
  });

  it('keeps keys, bookmarks and the session readable', () => {
    const key = nodeKey('a', ['my/db', 'schemas']);
    expect(keyPath(key)).toEqual({ connection: 'a', path: ['my/db', 'schemas'] });
    const mark = { connection: 'a', path: ['shop'], label: 'shop', kind: 'database' };
    expect(toggleBookmark(toggleBookmark([], mark), mark)).toEqual([]);
    expect(readDatabaseSession({ expanded: ['x', 1], bookmarks: [mark, { bad: 1 }] })).toEqual({
      expanded: ['x'],
      active: '',
      bookmarks: [mark],
      simple: true,
      tabs: [],
      activeTab: '',
      drafts: {},
    });
  });

  it('keeps the editor tabs and the text of their scripts, not more', () => {
    const session = readDatabaseSession({
      tabs: [
        { id: 's', kind: 'sql', connection: 'a', title: 'Script' },
        { id: 'o', kind: 'object', connection: 'a', title: 'orders', path: ['shop', 'orders'] },
        { id: 'x', kind: 'chart' },
      ],
      activeTab: 'o',
      drafts: { s: { text: 'select 1', cursor: 3, dirty: true }, gone: { text: 'x' } },
    });
    expect(session.tabs.map((tab) => tab.id)).toEqual(['s', 'o']);
    expect(session.tabs[1].path).toEqual(['shop', 'orders']);
    expect(session.activeTab).toBe('o');
    expect(session.drafts).toEqual({ s: { text: 'select 1', cursor: 3, dirty: true } });
    // A saved script that did not change reopens from its document.
    expect(storedDrafts({ s: { text: 'select 1', cursor: 3, script: 'd1' } })).toEqual({
      s: { text: '', cursor: 3, script: 'd1' },
    });
  });
});

describe('the saved scripts in the navigator', () => {
  const scripts = [
    { id: 's1', name: 'Totals', value: { connectionId: 'b', sql: '', folder: 'Reports' } },
    { id: 's2', name: 'Alpha', value: { connectionId: 'b', sql: '' } },
    { id: 's3', name: 'Orphan', value: { connectionId: 'gone', sql: '' } },
    { id: 's4', name: 'Orders', value: { connectionId: 'a', sql: '' } },
  ];

  it('lists them by connection name, each by name, with their folder', () => {
    const rows = navigatorRows(snapshot({ scripts })).filter((row) => row.level >= 1);
    const listed = rows.filter((row) => row.type?.startsWith('script') || row.type === 'scripts');
    expect(listed.map((row) => [row.type, row.label, row.detail])).toEqual([
      ['scripts', 'Scripts', undefined],
      ['script-group', '—', undefined],
      ['script', 'Orphan', undefined],
      ['script-group', 'Local', undefined],
      ['script', 'Alpha', undefined],
      ['script', 'Totals', 'Reports'],
      ['script-group', 'Shop', undefined],
      ['script', 'Orders', undefined],
    ]);
  });

  it('folds the scripts and their groups, and opens them all while searching', () => {
    const closed = navigatorRows(snapshot({ scripts, closedFolders: new Set(['scripts']) }));
    expect(closed.filter((row) => row.type === 'script')).toEqual([]);
    const group = navigatorRows(snapshot({ scripts, closedFolders: new Set(['scripts:b']) }));
    expect(group.filter((row) => row.type === 'script').map((row) => row.label)).toEqual([
      'Orphan',
      'Orders',
    ]);
    const found = navigatorRows(
      snapshot({ scripts, closedFolders: new Set(['scripts', 'scripts:b']), text: 'tot' }),
    );
    expect(found.filter((row) => row.type === 'script').map((row) => row.label)).toEqual([
      'Totals',
    ]);
    expect(
      navigatorRows(snapshot({ scripts, text: 'zzz' })).some((row) => row.type === 'scripts'),
    ).toBe(false);
  });

  it('describes a connection without a driver by its address only', () => {
    const rows = navigatorRows(
      snapshot({
        connections: [{ id: 'a', name: 'Bare', value: { host: 'h', port: 1 } }],
        folders: [{ folder: '', connections: [{ id: 'a' }] }],
        children: new Map([[nodeKey('a', []), [node('t', { detail: 'note' })]]]),
        expanded: new Set([nodeKey('a', [])]),
      }),
    );
    expect(rows.find((row) => row.type === 'connection')?.detail).toBe('h:1');
    expect(rows.find((row) => row.label === 't')?.detail).toBe('note');
  });
});
