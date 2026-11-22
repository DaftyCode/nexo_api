import { describe, expect, it } from 'vitest';
import {
  DBEAVER_DATA_SOURCES,
  PGADMIN_SERVERS,
  WORKBENCH_CONNECTIONS,
} from '../../testing/db-import-files';
import type { WorkspaceDocument } from '../models';
import { engineOf, exportConnections, readConnectionFile } from './import';

const ids = () => {
  let next = 0;
  return () => `id${++next}`;
};
const read = (text: string) => readConnectionFile(text, ids());
const values = (text: string) =>
  read(text)
    .documents.filter((document) => document.kind === 'connection')
    .map((document) => ({ name: document.name, ...document.value }));

describe('importing connections', () => {
  it('reads DBeaver with its folders, types, startup settings and tunnels, without passwords', () => {
    const imported = read(DBEAVER_DATA_SOURCES);
    expect(imported.source).toBe('dbeaver');
    // One SSH profile for the bastion both connections go through, before them.
    const [bastion] = imported.documents;
    expect(bastion).toEqual({
      id: 'id1',
      kind: 'ssh-profile',
      name: 'user@bastion.example.com:2222',
      value: {
        host: 'bastion.example.com',
        port: 2222,
        username: 'user',
        auth: 'key',
        secret: 'ssh-id1',
      },
    });
    expect(imported.documents.filter((d) => d.kind === 'ssh-profile')).toHaveLength(1);
    expect(values(DBEAVER_DATA_SOURCES)).toEqual([
      {
        name: 'Orders (EU)',
        driver: 'postgres',
        host: 'db.internal',
        port: 5432,
        database: 'orders',
        user: 'reports',
        type: 'production',
        folder: 'Shop/Shop EU',
        readOnly: true,
        autoCommit: false,
        defaultSchema: 'sales',
        startupQueries: ["SET application_name = 'nexo'"],
        tls: { mode: 'verify' },
        route: { via: 'ssh', profile: 'id1' },
        askPassword: true,
      },
      {
        name: 'Catalog',
        driver: 'mysql',
        host: 'mysql.internal',
        port: 3306,
        database: 'catalog',
        type: 'development',
        folder: 'Shop',
        route: { via: 'ssh', profile: 'id1' },
      },
      {
        name: 'Scratch',
        driver: 'sqlite',
        database: 'C:\\data\\scratch.db',
        type: 'development',
        folder: 'Local',
      },
      {
        name: 'Billing',
        driver: 'mssql',
        host: 'sql.example.com',
        port: 1433,
        database: 'billing',
        user: 'sa',
        type: 'test',
        route: { via: 'socks5', host: 'proxy.example.com', port: '1080', remoteDns: true },
        askPassword: true,
      },
    ]);
    expect(imported.skipped).toEqual([{ name: 'Legacy', reason: 'engine' }]);
    expect(imported.notes).toEqual([
      { code: 'password', items: ['Orders (EU)', 'Billing'] },
      { code: 'user', items: ['Orders (EU)', 'Catalog'] },
      { code: 'sshPassword', items: ['Catalog'] },
      { code: 'sshKey', items: ['Orders (EU)'] },
      { code: 'type', items: ['Catalog'] },
      { code: 'tlsFiles', items: ['Orders (EU)'] },
    ]);
  });

  it('reads pgAdmin servers with their groups, pass file, SSL and SSH tunnel', () => {
    const imported = read(PGADMIN_SERVERS);
    expect(imported.source).toBe('pgadmin');
    expect(values(PGADMIN_SERVERS)).toEqual([
      {
        name: 'Local',
        driver: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'postgres',
        user: 'postgres',
        folder: 'Servers',
        tls: { mode: 'prefer' },
        connectTimeoutSeconds: 10,
        askPassword: true,
      },
      {
        name: 'Reports',
        driver: 'postgres',
        host: 'db.internal',
        port: 5433,
        database: 'reports',
        user: 'reader',
        folder: 'Production',
        description: 'Read replica',
        tls: { mode: 'verify' },
        pgpass: true,
        connectTimeoutSeconds: 120,
        route: { via: 'ssh', profile: 'id2' },
      },
    ]);
    // Each profile comes before the connection that names it.
    expect(imported.documents[1]).toMatchObject({
      id: 'id2',
      kind: 'ssh-profile',
      value: { host: 'bastion.example.com', port: 22, username: 'ana', auth: 'key' },
    });
    expect(imported.notes.map((note) => note.code)).toEqual([
      'password',
      'sshKey',
      'passFile',
      'tlsFiles',
    ]);
  });

  it('reads MySQL Workbench connections, and leaves out those on a local socket', () => {
    const imported = read(WORKBENCH_CONNECTIONS);
    expect(imported.source).toBe('workbench');
    expect(values(WORKBENCH_CONNECTIONS)).toEqual([
      {
        name: 'Shop & stock',
        driver: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        database: 'shop',
        user: 'root',
        tls: { mode: 'require' },
        askPassword: true,
      },
      {
        name: 'Remote',
        driver: 'mysql',
        host: '10.0.0.5',
        port: 3307,
        user: 'app',
        route: { via: 'ssh', profile: 'id2' },
        askPassword: true,
      },
    ]);
    expect(imported.documents[1].value).toMatchObject({ host: 'bastion.example.com', port: 2200 });
    expect(imported.skipped).toEqual([{ name: 'Socket', reason: 'socket' }]);
    expect(() => read('<data><value></data>')).toThrow(
      'Nexo does not know the connections of this file',
    );
  });

  it('reads a list of URLs, leaving their passwords out', () => {
    const list = [
      '# staging',
      'postgresql://ana:secret@db.example.com:5432/shop?sslmode=require',
      '',
      'jdbc:mysql://root@127.0.0.1/catalog',
      'sqlite:///C:/data/local.db',
      'ftp://nowhere',
    ].join('\n');
    const imported = read(list);
    expect(imported.source).toBe('urls');
    expect(values(list)).toEqual([
      {
        name: 'ana@db.example.com:5432/shop',
        driver: 'postgres',
        host: 'db.example.com',
        port: '5432',
        database: 'shop',
        user: 'ana',
        tls: { mode: 'require' },
        askPassword: true,
      },
      {
        name: 'root@127.0.0.1/catalog',
        driver: 'mysql',
        host: '127.0.0.1',
        database: 'catalog',
        user: 'root',
        askPassword: true,
      },
      expect.objectContaining({ driver: 'sqlite', database: 'C:/data/local.db' }),
    ]);
    expect(JSON.stringify(imported)).not.toContain('secret');
    expect(imported.skipped).toEqual([{ name: 'ftp://nowhere', reason: 'url' }]);
  });

  it('says what it cannot read', () => {
    expect(() => read('  ')).toThrow('The file has no connections');
    expect(() => read('{"other": 1}')).toThrow('Nexo does not know the connections of this file');
    expect(() => read('x'.repeat(5 * 1024 * 1024 + 1))).toThrow('The file is too large to import');
    expect(() => read('{"nexo": "connections", "version": 9}')).toThrow(
      'Nexo does not know the connections of this file',
    );
    expect(engineOf('redshift')).toBe('');
    expect(engineOf('mariaDB')).toBe('mysql');
  });
});

describe("Nexo's own file of connections", () => {
  const document = (id: string, kind: string, value: unknown): WorkspaceDocument => ({
    id,
    workspace_id: 'w',
    kind,
    name: id,
    revision: 1,
    updated_at: 0,
    value,
  });
  const documents = [
    document('c1', 'connection', {
      driver: 'postgres',
      host: 'db',
      user: 'ana',
      password: '{{vault:db-password:c1}}',
      type: 'staging',
      tls: { mode: 'verify', certPem: 'CERT', keyPem: '{{vault:db-key:c1}}' },
      route: { via: 'ssh', profile: 'bastion' },
    }),
    document('c2', 'connection', {
      driver: 'mysql',
      user: 'app',
      route: { via: 'socks5', host: 'p', username: 'u', password: '{{vault:db-proxy:c2}}' },
    }),
    document('c3', 'connection', { driver: 'postgres', pgpass: true, user: 'x', password: 'y' }),
    document('m1', 'connection', { uri: 'mongodb://db' }),
    document('bastion', 'ssh-profile', {
      host: 'b',
      username: 'ana',
      auth: 'key',
      secret: 'ssh-bastion',
      passphraseSecret: 'ssh-bastion-passphrase',
    }),
    document('staging', 'connection-type', { confirmStructure: true }),
    document('other', 'proxy-profile', { protocol: 'socks5', host: 'q' }),
  ];

  it('exports the connections chosen with what they name, and no secret', () => {
    const text = exportConnections(documents, ['c1', 'c2', 'c3', 'm1']);
    expect(text).not.toMatch(/vault|ssh-bastion/);
    const file = JSON.parse(text);
    expect(file.connections.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(file.connections[0].value).toMatchObject({
      askPassword: true,
      tls: { mode: 'verify', certPem: 'CERT' },
    });
    expect(file.connections[2].value.askPassword).toBeUndefined();
    expect(file.profiles.map((p: { id: string }) => p.id)).toEqual(['bastion', 'staging']);
  });

  it('imports it back with new ids, what the connections name following them', () => {
    const imported = read(exportConnections(documents, ['c1', 'c2']));
    expect(imported.source).toBe('nexo');
    expect(imported.documents.map((d) => [d.id, d.kind])).toEqual([
      ['id1', 'ssh-profile'],
      ['id2', 'connection-type'],
      ['id3', 'connection'],
      ['id4', 'connection'],
    ]);
    expect(imported.documents[0].value).toEqual({
      host: 'b',
      username: 'ana',
      auth: 'key',
      secret: 'ssh-id1',
    });
    expect(imported.documents[2].value).toMatchObject({
      type: 'id2',
      route: { via: 'ssh', profile: 'id1' },
      askPassword: true,
    });
    expect(imported.notes).toEqual([
      { code: 'password', items: ['c1', 'c2'] },
      { code: 'sshKey', items: ['bastion'] },
      { code: 'proxyPassword', items: ['c2'] },
    ]);
  });
});
