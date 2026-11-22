/**
 * DBeaver's `data-sources.json` («data-sources.json reference» of its wiki): engine, host,
 * port, database, user, folder, type, startup settings, SSH tunnel and SOCKS proxy. Its
 * passwords are encrypted in `credentials-config.json`, which is never read: the imported
 * connections ask for them.
 */
import type { DbConnectionValue, TlsMode } from '../connection';
import { tlsModeOf } from '../engines';
import { ConnectionImport, ImportBuilder, engineOf } from './builder';

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
const number = (value: unknown) => {
  const parsed = Number(text(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const TYPES: Record<string, string> = { dev: 'development', test: 'test', prod: 'production' };

/** The path of a folder: DBeaver keeps each one with its parent. */
function folderPath(folders: Json, name: string): string {
  const parts: string[] = [];
  let current = name;
  while (current && parts.length < 16 && !parts.includes(current)) {
    parts.unshift(current);
    current = text(record(folders[current])['parent']);
  }
  return parts.join('/');
}

/** The TLS mode of its SSL handler, when one is on. */
function tlsOf(handlers: Json, name: string, builder: ImportBuilder): TlsMode | undefined {
  for (const [id, handler] of Object.entries(handlers)) {
    const settings = record(handler);
    if (!/ssl/i.test(id) || settings['enabled'] !== true) continue;
    const properties = record(settings['properties']);
    if (Object.keys(properties).some((key) => /cert|key|ca/i.test(key) && text(properties[key])))
      builder.note('tlsFiles', name);
    return tlsModeOf(text(properties['sslMode'] ?? properties['ssl.mode'])) ?? 'require';
  }
  return undefined;
}

/** How it reaches its server: its SSH tunnel, or its SOCKS proxy written in. */
function routeOf(handlers: Json, name: string, builder: ImportBuilder): DbConnectionValue['route'] {
  const tunnel = record(handlers['ssh_tunnel']);
  if (tunnel['enabled'] === true) {
    const properties = record(tunnel['properties']);
    const user = text(properties['user'] ?? tunnel['user']);
    if (!user) builder.note('user', name);
    const key = /key/i.test(text(properties['authType']));
    const host = text(properties['host']);
    const port = number(properties['port']) ?? 22;
    const profile = builder.ssh(host, port, user || 'user', key, name);
    return { via: 'ssh', profile };
  }
  const proxy = record(handlers['socks_proxy']);
  if (proxy['enabled'] === true) {
    const properties = record(proxy['properties']);
    const port = text(properties['socks-port']);
    if (text(properties['socks-user'] ?? proxy['user'])) builder.note('proxyPassword', name);
    return {
      via: 'socks5',
      host: text(properties['socks-host']),
      ...(port ? { port } : {}),
      ...(text(properties['socks-user']) ? { username: text(properties['socks-user']) } : {}),
      remoteDns: true,
    };
  }
  return undefined;
}

export function readDbeaver(file: Json, builder: ImportBuilder): ConnectionImport {
  const folders = record(file['folders']);
  for (const [id, entry] of Object.entries(record(file['connections']))) {
    const source = record(entry);
    const name = text(source['name']) || id;
    const configuration = record(source['configuration']);
    const driver = engineOf(`${text(source['provider'])} ${text(source['driver'])}`);
    if (!driver) {
      builder.skip(name, 'engine');
      continue;
    }
    const handlers = record(configuration['handlers']);
    const bootstrap = record(configuration['bootstrap']);
    const kind = text(configuration['type']);
    const type = TYPES[kind];
    if (kind && !type) builder.note('type', name);
    const sqlite = driver === 'sqlite';
    const url = text(configuration['url']);
    const database =
      text(configuration['database']) || (sqlite ? url.replace(/^jdbc:sqlite:/i, '') : '');
    const queries = Array.isArray(bootstrap['initQueries'])
      ? bootstrap['initQueries'].map(text).filter(Boolean).slice(0, 20)
      : [];
    const tls = sqlite ? undefined : tlsOf(handlers, name, builder);
    const folder = text(source['folder']);
    builder.connection(name, {
      driver,
      host: sqlite ? undefined : text(configuration['host']),
      port: sqlite ? undefined : number(configuration['port']),
      database,
      user: sqlite ? undefined : text(configuration['user']),
      type: type ?? 'development',
      folder: folder ? folderPath(folders, folder) : undefined,
      description: text(source['description']) || undefined,
      readOnly: source['read-only'] === true || undefined,
      autoCommit:
        typeof bootstrap['autocommit'] === 'boolean' ? bootstrap['autocommit'] : undefined,
      defaultSchema:
        driver === 'postgres' ? text(bootstrap['defaultSchema']) || undefined : undefined,
      startupQueries: queries.length ? queries : undefined,
      tls: tls ? { mode: tls } : undefined,
      route: sqlite ? undefined : routeOf(handlers, name, builder),
    });
  }
  return builder.result();
}
