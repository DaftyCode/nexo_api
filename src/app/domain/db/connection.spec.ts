import { describe, expect, it } from 'vitest';
import {
  autoCommits,
  connectionType,
  dbFolders,
  filterAt,
  isDbConnection,
  readDbConnection,
  tableKey,
  withFilter,
} from './connection';

describe('the session settings of a connection', () => {
  it('reads what is valid and leaves out the rest', () => {
    expect(
      readDbConnection({
        driver: 'postgres',
        defaultSchema: 'sales',
        startupQueries: ['SET a = 1', ' ', 7],
        ignoreStartupErrors: true,
        keepAliveSeconds: 30,
        idleMinutes: 2.5,
        connectTimeoutSeconds: -1,
      }),
    ).toEqual({
      driver: 'postgres',
      defaultSchema: 'sales',
      startupQueries: ['SET a = 1'],
      ignoreStartupErrors: true,
      keepAliveSeconds: 30,
    });
    // A password asked for wins over pgpass.
    expect(readDbConnection({ driver: 'postgres', askPassword: true, pgpass: true })).toEqual({
      driver: 'postgres',
      askPassword: true,
    });
    expect(readDbConnection({ driver: 'postgres', pgpass: true })).toEqual({
      driver: 'postgres',
      pgpass: true,
    });
  });
});

describe('the route of a connection', () => {
  it('keeps a SOCKS5 proxy or an SSH profile and reads anything else as direct', () => {
    expect(
      readDbConnection({ driver: 'postgres', route: { via: 'ssh', profile: 'p1', host: 'x' } })
        .route,
    ).toEqual({ via: 'ssh', profile: 'p1' });
    expect(
      readDbConnection({
        driver: 'postgres',
        route: { via: 'socks5', host: 'p', port: 1080, username: 'a', password: '{{vault:x}}' },
      }).route,
    ).toEqual({
      via: 'socks5',
      host: 'p',
      port: '1080',
      username: 'a',
      password: '{{vault:x}}',
      remoteDns: true,
    });
    for (const route of [{ via: 'http', host: 'p' }, { via: 'direct' }, 'ssh', undefined])
      expect(readDbConnection({ driver: 'postgres', route })).not.toHaveProperty('route');
  });
});

describe('a stored database connection', () => {
  it('is read defensively, keeping only what has the right shape', () => {
    const value = readDbConnection({
      driver: 'postgres',
      host: ' db ',
      port: '5432',
      database: '',
      user: 7,
      folder: 'Shop',
      params: { search_path: 'shop', bad: 3 },
      tls: { mode: 'verify', caPem: 'CA', certPem: ' ', keyPem: 'KEY' },
      type: 'production',
      readOnly: true,
      autoCommit: false,
      smartCommit: true,
      sharedSession: true,
      timeoutSeconds: 30,
      filters: [
        { path: ['shop'], include: ' a* ', exclude: '' },
        { path: ['x'], include: '', exclude: ' ' },
        { path: 'shop', include: 'a' },
        { path: [1], include: 'a' },
        { path: ['y'], exclude: 'tmp_*' },
      ],
      virtualKeys: { 'shop.log': ['id'], empty: [], wrong: [1], other: 'id' },
      virtualColumns: {
        'shop.orders': [
          { name: ' total ', expression: 'price * 2' },
          { name: '', expression: 'x' },
          { name: 'blank', expression: ' ' },
          'not a column',
        ],
        'shop.none': 'nothing',
        'shop.empty': [{ name: 'a' }],
      },
    });
    expect(value).toEqual({
      driver: 'postgres',
      host: ' db ',
      folder: 'Shop',
      port: '5432',
      params: { search_path: 'shop' },
      tls: { mode: 'verify', caPem: 'CA', keyPem: 'KEY' },
      type: 'production',
      readOnly: true,
      autoCommit: false,
      smartCommit: true,
      sharedSession: true,
      timeoutSeconds: 30,
      filters: [
        { path: ['shop'], include: 'a*' },
        { path: ['y'], exclude: 'tmp_*' },
      ],
      virtualKeys: { 'shop.log': ['id'] },
      virtualColumns: { 'shop.orders': [{ name: 'total', expression: 'price * 2' }] },
    });
  });

  it('drops what is missing, wrong or off', () => {
    expect(readDbConnection(undefined)).toEqual({ driver: '' });
    expect(readDbConnection([1, 2])).toEqual({ driver: '' });
    expect(
      readDbConnection({
        driver: 'mysql',
        port: ' ',
        tls: { mode: 'disable' },
        type: 7,
        readOnly: 'yes',
        timeoutSeconds: -1,
        filters: 'all',
        virtualKeys: [],
      }),
    ).toEqual({ driver: 'mysql' });
    expect(
      readDbConnection({ driver: 'mysql', port: 3306, tls: { mode: 'x', caPem: 'CA' } }),
    ).toEqual({ driver: 'mysql', port: 3306, tls: { mode: 'disable', caPem: 'CA' } });
  });

  it('has a type, and commits by itself unless it is for production', () => {
    expect(connectionType({ driver: 'x' })).toBe('development');
    expect(autoCommits({ driver: 'x' })).toBe(true);
    expect(autoCommits({ driver: 'x', type: 'production' })).toBe(false);
    expect(autoCommits({ driver: 'x', type: 'production', autoCommit: true })).toBe(true);
    // A type of your own: its rules say, unless the connection does.
    const own = {
      autoCommit: false,
      confirmWrites: false,
      confirmStructure: true,
      readOnly: false,
    };
    expect(readDbConnection({ driver: 'x', type: 'staging' }).type).toBe('staging');
    expect(autoCommits({ driver: 'x', type: 'staging' }, own)).toBe(false);
    expect(autoCommits({ driver: 'x', type: 'staging', autoCommit: true }, own)).toBe(true);
  });

  it('is a connection of a database module, not of MongoDB', () => {
    expect(isDbConnection({ kind: 'connection', value: { driver: 'postgres' } })).toBe(true);
    expect(isDbConnection({ kind: 'connection', value: { driver: 'mongodb' } })).toBe(false);
    expect(isDbConnection({ kind: 'connection' })).toBe(false);
    expect(isDbConnection({ kind: 'request', value: { driver: 'postgres' } })).toBe(false);
  });

  it('names a table key with its schema when it has one', () => {
    expect(tableKey('orders', 'shop')).toBe('shop.orders');
    expect(tableKey('orders')).toBe('orders');
  });
});

describe('the filters of a connection', () => {
  const value = {
    driver: 'postgres',
    filters: [
      { path: ['shop'], include: 'a*' },
      { path: ['shop', 'tables'], exclude: 'tmp_*' },
    ],
  };

  it('finds the filter of a path', () => {
    expect(filterAt(value, ['shop'])).toEqual({ path: ['shop'], include: 'a*' });
    expect(filterAt(value, ['shop', 'views'])).toBeUndefined();
    expect(filterAt({ driver: 'x' }, ['shop'])).toBeUndefined();
  });

  it('replaces the filter of a path, and removes it when both texts are empty', () => {
    expect(withFilter(value, ['shop'], ' b* ', '')).toEqual([
      { path: ['shop', 'tables'], exclude: 'tmp_*' },
      { path: ['shop'], include: 'b*' },
    ]);
    expect(withFilter(value, ['shop', 'tables'], '', ' x ')).toEqual([
      { path: ['shop'], include: 'a*' },
      { path: ['shop', 'tables'], exclude: 'x' },
    ]);
    expect(withFilter(value, ['shop'], ' ', '')).toEqual([
      { path: ['shop', 'tables'], exclude: 'tmp_*' },
    ]);
    expect(withFilter({ driver: 'x' }, ['a'], 'b', 'c')).toEqual([
      { path: ['a'], include: 'b', exclude: 'c' },
    ]);
  });
});

describe('the folders of the connections', () => {
  it('groups by folder, the ones without a folder first, each by name', () => {
    const groups = dbFolders([
      { name: 'b', value: { driver: 'x', folder: 'Work' } },
      { name: 'z', value: { driver: 'x' } },
      { name: 'a', value: { driver: 'x', folder: 'Work' } },
      { name: 'c', value: { driver: 'x', folder: 'Home' } },
      { name: 'y', value: { driver: 'x' } },
    ]);
    expect(groups.map((group) => [group.folder, group.connections.map((c) => c.name)])).toEqual([
      ['', ['y', 'z']],
      ['Home', ['c']],
      ['Work', ['a', 'b']],
    ]);
    expect(
      dbFolders([
        { name: 'b', value: { folder: 'B' } },
        { name: 'a', value: {} },
      ])[0],
    ).toEqual({ folder: '', connections: [{ name: 'a', value: {} }] });
  });
});
