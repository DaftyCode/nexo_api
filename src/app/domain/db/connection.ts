/**
 * A saved connection of a database module, as the backend stores it (`connection` documents
 * that name their `driver`). Its secrets are never stored: the password and the client key
 * are references to the vault (`{{vault:…}}`).
 */
import { isVaultReference } from '../mongo';

/** How careful Nexo is with a connection, as DBeaver's connection types. */
export type ConnectionType = 'development' | 'test' | 'production';
export const CONNECTION_TYPES: readonly ConnectionType[] = ['development', 'test', 'production'];

/** How a connection uses TLS, as every driver understands it. */
export type TlsMode = 'disable' | 'prefer' | 'require' | 'verify';
export const TLS_MODES: readonly TlsMode[] = ['disable', 'prefer', 'require', 'verify'];

export interface DbTls {
  mode: TlsMode;
  caPem?: string;
  certPem?: string;
  /** A vault reference. */
  keyPem?: string;
}

/**
 * Which children of a node the navigator shows, as DBeaver's filters: names matching one of
 * `include` (when given) and none of `exclude`. Patterns are separated by commas and use `*`
 * (or `%`) and `?`.
 */
export interface NodeFilter {
  path: string[];
  include?: string;
  exclude?: string;
}

export interface DbConnectionValue {
  driver: string;
  host?: string;
  /** A number, or a `{{variable}}` replaced when it connects. */
  port?: number | string;
  database?: string;
  user?: string;
  /** A vault reference. */
  password?: string;
  /** Settings of the driver, from the closed list it accepts. */
  params?: Record<string, string>;
  tls?: DbTls;
  type?: ConnectionType;
  folder?: string;
  color?: string;
  description?: string;
  readOnly?: boolean;
  /** Off: statements wait for a commit. Production connections start with it off. */
  autoCommit?: boolean;
  /** The longest a statement may run, in seconds. */
  timeoutSeconds?: number;
  filters?: NodeFilter[];
}

/** The vault entries Nexo creates for a connection. */
export const dbPasswordSecret = (id: string) => `db-password:${id}`;
export const dbKeySecret = (id: string) => `db-key:${id}`;
export const vaultReference = (name: string) => `{{vault:${name}}}`;
export { isVaultReference };

/** Whether a document is a connection of a database module (MongoDB's name no driver). */
export function isDbConnection(document: { kind: string; value?: unknown }): boolean {
  const driver = (document.value as { driver?: unknown } | undefined)?.driver;
  return document.kind === 'connection' && typeof driver === 'string' && driver !== 'mongodb';
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function texts(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function filters(value: unknown): NodeFilter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): NodeFilter[] => {
    const filter = record(item);
    const path = filter['path'];
    if (!Array.isArray(path) || !path.every((segment) => typeof segment === 'string')) return [];
    const include = typeof filter['include'] === 'string' ? filter['include'].trim() : '';
    const exclude = typeof filter['exclude'] === 'string' ? filter['exclude'].trim() : '';
    if (!include && !exclude) return [];
    return [{ path, ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) }];
  });
}

/** A stored value read defensively: documents can come from Git or older versions. */
export function readDbConnection(value: unknown): DbConnectionValue {
  const source = record(value);
  const text = (key: string) =>
    typeof source[key] === 'string' && source[key].trim() ? source[key] : undefined;
  const tls = record(source['tls']);
  const mode = TLS_MODES.find((candidate) => candidate === tls['mode']) ?? 'disable';
  const tlsText = (key: string) =>
    typeof tls[key] === 'string' && tls[key].trim() ? { [key]: tls[key] } : {};
  const port = source['port'];
  const type = CONNECTION_TYPES.find((candidate) => candidate === source['type']);
  const timeout = source['timeoutSeconds'];
  const params = texts(source['params']);
  const kept = filters(source['filters']);
  const optional = {
    host: text('host'),
    database: text('database'),
    user: text('user'),
    password: text('password'),
    folder: text('folder'),
    color: text('color'),
    description: text('description'),
  };
  return {
    driver: text('driver') ?? '',
    ...Object.fromEntries(Object.entries(optional).filter(([, item]) => item !== undefined)),
    ...(typeof port === 'number' || (typeof port === 'string' && port.trim()) ? { port } : {}),
    ...(Object.keys(params).length ? { params } : {}),
    ...(mode !== 'disable' || Object.keys(tls).length > 1
      ? { tls: { mode, ...tlsText('caPem'), ...tlsText('certPem'), ...tlsText('keyPem') } }
      : {}),
    ...(type ? { type } : {}),
    ...(source['readOnly'] === true ? { readOnly: true } : {}),
    ...(typeof source['autoCommit'] === 'boolean' ? { autoCommit: source['autoCommit'] } : {}),
    ...(typeof timeout === 'number' && timeout > 0 ? { timeoutSeconds: timeout } : {}),
    ...(kept.length ? { filters: kept } : {}),
  };
}

/** The type of a connection; one without a type is for development. */
export function connectionType(value: DbConnectionValue): ConnectionType {
  return value.type ?? 'development';
}

/** Whether statements commit by themselves: production connections start with it off. */
export function autoCommits(value: DbConnectionValue): boolean {
  return value.autoCommit ?? connectionType(value) !== 'production';
}

/** The filter kept for the children of a node, if any. */
export function filterAt(value: DbConnectionValue, path: readonly string[]) {
  return value.filters?.find(
    (filter) =>
      filter.path.length === path.length && filter.path.every((part, i) => part === path[i]),
  );
}

/** The filters of a connection with the one of `path` replaced, or removed when it is empty. */
export function withFilter(
  value: DbConnectionValue,
  path: readonly string[],
  include: string,
  exclude: string,
): NodeFilter[] {
  const others = (value.filters ?? []).filter((filter) => filter !== filterAt(value, path));
  const kept = { include: include.trim(), exclude: exclude.trim() };
  if (!kept.include && !kept.exclude) return others;
  return [
    ...others,
    {
      path: [...path],
      ...(kept.include ? { include: kept.include } : {}),
      ...(kept.exclude ? { exclude: kept.exclude } : {}),
    },
  ];
}

/** The connections of a workspace, grouped by folder (no folder first), by name. */
export function dbFolders<T extends { name: string; value: unknown }>(
  connections: readonly T[],
): { folder: string; connections: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const connection of [...connections].sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = readDbConnection(connection.value).folder ?? '';
    groups.set(folder, [...(groups.get(folder) ?? []), connection]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, items]) => ({ folder, connections: items }));
}
