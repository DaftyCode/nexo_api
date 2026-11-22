/**
 * A saved connection of a database module, as the backend stores it (`connection` documents
 * that name their `driver`). Its secrets are never stored: the password, the client key and
 * the password of its proxy are references to the vault (`{{vault:…}}`).
 */
import { isVaultReference } from '../mongo';
import { StoredRoute, readRoute, storedRoute } from '../route';
import { sessionSettings } from './connection/session';

/** How careful Nexo is with a connection, as DBeaver's connection types. */
/** `development`, `test`, `production`, or the id of a type of the person's own (DB-25). */
export type ConnectionType = string;
export const CONNECTION_TYPES: readonly ConnectionType[] = ['development', 'test', 'production'];
import type { TypeRules } from './connection-types';

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
  /** MCP agents may read it (DB-32), never write; without the columns of `mcpHidden`
   * (`table.column`, `column` or patterns with `*`). */
  mcp?: boolean;
  mcpHidden?: string[];
  /** Off: statements wait for a commit. Production connections start with it off. */
  autoCommit?: boolean;
  /** In auto-commit, a statement that writes switches to manual commit first (DBeaver's
   * «smart commit»), so it can be rolled back. */
  smartCommit?: boolean;
  /** The SQL tabs of the connection share one session, and so one transaction. */
  sharedSession?: boolean;
  /** The longest a statement may run, in seconds. */
  timeoutSeconds?: number;
  /** The folder of the engine's client tools (`pg_dump`, `mysql`…), desktop only. */
  localClient?: string;
  filters?: NodeFilter[];
  /** The columns that name each row of a table without a key, by `schema.table`, chosen to
   * edit its rows in the grid (DBeaver's virtual keys). */
  virtualKeys?: Record<string, string[]>;
  /** Columns computed in the interface from the others, by `schema.table` (DB-13). */
  virtualColumns?: Record<string, { name: string; expression: string }[]>;
  /** How it reaches its server: a SOCKS5 proxy or an SSH profile (DB-25); none: directly. */
  route?: StoredRoute;
  /** PostgreSQL's `search_path` of every session: one or several schemas, with commas. */
  defaultSchema?: string;
  /** Run in every session as it opens, one statement each. */
  startupQueries?: string[];
  /** A startup query that fails is said, and the session still opens. */
  ignoreStartupErrors?: boolean;
  /** A trivial query every so many seconds while it is not used. */
  keepAliveSeconds?: number;
  /** Closed after so many minutes unused, under the ten of every connection. */
  idleMinutes?: number;
  /** The longest it may take to open. */
  connectTimeoutSeconds?: number;
  /** It keeps no password: it is asked for when a session of it opens (DB-25). */
  askPassword?: boolean;
  /** PostgreSQL: it keeps no password: the user's pgpass file gives it. */
  pgpass?: boolean;
}

/** The vault entries Nexo creates for a connection. */
export const dbPasswordSecret = (id: string) => `db-password:${id}`;
export const dbKeySecret = (id: string) => `db-key:${id}`;
export const dbProxySecret = (id: string) => `db-proxy:${id}`;
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

function virtualKeys(value: unknown): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) &&
        entry[1].length > 0 &&
        entry[1].every((column) => typeof column === 'string'),
    ),
  );
}

function virtualColumns(value: unknown): Record<string, { name: string; expression: string }[]> {
  return Object.fromEntries(
    Object.entries(record(value)).flatMap(([table, list]) => {
      const kept = (Array.isArray(list) ? list : []).flatMap((item) => {
        const column = record(item);
        const name = typeof column['name'] === 'string' ? column['name'].trim() : '';
        const expression = typeof column['expression'] === 'string' ? column['expression'] : '';
        return name && expression.trim() ? [{ name, expression }] : [];
      });
      return kept.length ? [[table, kept]] : [];
    }),
  );
}

/** The name a table's virtual key is kept under. */
export const tableKey = (table: string, schema?: string) => (schema ? `${schema}.${table}` : table);

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
  const type = text('type');
  const timeout = source['timeoutSeconds'];
  const params = texts(source['params']);
  const kept = filters(source['filters']);
  const keys = virtualKeys(source['virtualKeys']);
  const computed = virtualColumns(source['virtualColumns']);
  // Database protocols go through SOCKS5 or SSH only; anything else reads as direct.
  const read = readRoute(source['route']);
  const route = read.via === 'socks5' || read.via === 'ssh' ? storedRoute(read) : undefined;
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
    ...(source['smartCommit'] === true ? { smartCommit: true } : {}),
    ...(source['sharedSession'] === true ? { sharedSession: true } : {}),
    ...(typeof timeout === 'number' && timeout > 0 ? { timeoutSeconds: timeout } : {}),
    ...(typeof source['localClient'] === 'string' && source['localClient'].trim()
      ? { localClient: source['localClient'] }
      : {}),
    ...(kept.length ? { filters: kept } : {}),
    ...(Object.keys(keys).length ? { virtualKeys: keys } : {}),
    ...(Object.keys(computed).length ? { virtualColumns: computed } : {}),
    ...(route ? { route } : {}),
    ...sessionSettings(source),
  };
}

/** The type of a connection; one without a type is for development. */
export function connectionType(value: DbConnectionValue): ConnectionType {
  return value.type ?? 'development';
}

/** Whether statements commit by themselves: production connections start with it off. */
export function autoCommits(value: DbConnectionValue, rules?: TypeRules): boolean {
  return value.autoCommit ?? rules?.autoCommit ?? connectionType(value) !== 'production';
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
