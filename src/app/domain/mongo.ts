/**
 * MongoDB connections: the stored document, the form that edits it and the URI both come
 * from. The URI is kept without its password, which lives in the vault.
 */

export { formatMongoUri, parseMongoUri } from './mongo/uri';
export type { ParsedUri } from './mongo/uri';
export { parseCompassExport } from './mongo/compass';
export type { ImportedConnection } from './mongo/compass';

/** The value of a `connection` document. */
export interface MongoConnectionValue {
  /** `mongodb://` or `mongodb+srv://`, without a password. */
  uri: string;
  /** A `{{vault:…}}` reference. */
  password?: string;
  /** Certificate authority to trust besides the system's, in PEM. */
  caPem?: string;
  /** Client certificate for TLS authentication, in PEM. */
  certPem?: string;
  /** Its key: a `{{vault:…}}` reference. */
  keyPem?: string;
  folder?: string;
  color?: string;
  /** Writes are refused while it is set. */
  readOnly?: boolean;
}

/** A server of a connection, as "Test connection" found it. */
export interface DatabaseHost {
  address: string;
  role: string;
  allowed: boolean;
  reason?: string;
}
/** What "Test connection" found. */
export interface ConnectionReport {
  serverVersion: string;
  topology: 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced';
  replicaSet?: string;
  flavor?: string;
  hosts: DatabaseHost[];
  pingMs: number;
  direct: boolean;
  tls: boolean;
  authMechanism?: string;
}

export type AuthChoice = 'none' | 'default' | 'SCRAM-SHA-256' | 'SCRAM-SHA-1' | 'MONGODB-X509';
export const AUTH_CHOICES: readonly AuthChoice[] = [
  'none',
  'default',
  'SCRAM-SHA-256',
  'SCRAM-SHA-1',
  'MONGODB-X509',
];
export const READ_PREFERENCES = [
  '',
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
] as const;
/** Colours a connection can be marked with. */
export const CONNECTION_COLORS = [
  '#e5534b',
  '#d4a72c',
  '#57ab5a',
  '#39c5cf',
  '#539bf5',
  '#b083f0',
  '#e275ad',
] as const;

/** Everything the connection form edits; text fields stay text so they can be blank. */
export interface ConnectionForm {
  srv: boolean;
  /** One `host[:port]` per line. */
  hosts: string;
  database: string;
  replicaSet: string;
  auth: AuthChoice;
  username: string;
  authSource: string;
  tls: boolean;
  allowInvalidCertificates: boolean;
  readPreference: string;
  /** `dc:east,rack:1`; one tag set. */
  readPreferenceTags: string;
  w: string;
  wtimeoutMS: string;
  journal: boolean;
  connectTimeoutMS: string;
  socketTimeoutMS: string;
  serverSelectionTimeoutMS: string;
  retryWrites: boolean;
  directConnection: boolean;
  loadBalanced: boolean;
  /** Other options of the URI, kept as written: `appName=x&compressors=zlib`. */
  extra: string;
}

export function emptyConnectionForm(): ConnectionForm {
  return {
    srv: false,
    hosts: 'localhost:27017',
    database: '',
    replicaSet: '',
    auth: 'none',
    username: '',
    authSource: '',
    tls: false,
    allowInvalidCertificates: false,
    readPreference: '',
    readPreferenceTags: '',
    w: '',
    wtimeoutMS: '',
    journal: false,
    connectTimeoutMS: '',
    socketTimeoutMS: '',
    serverSelectionTimeoutMS: '',
    retryWrites: true,
    directConnection: false,
    loadBalanced: false,
    extra: '',
  };
}

/** What is wrong with a form before it is tested or saved, if anything. */
export function connectionProblem(form: ConnectionForm): string | undefined {
  const hosts = form.hosts
    .split(/[\n,]/)
    .map((host) => host.trim())
    .filter(Boolean);
  if (!hosts.length) return 'Add at least one host';
  if (form.srv && hosts.length > 1) return 'A DNS seed list (mongodb+srv) has one host name';
  if (form.srv && hosts.some((host) => /:\d+$/.test(host)))
    return 'A DNS seed list (mongodb+srv) has no port';
  if (form.directConnection && hosts.length > 1) return 'A direct connection goes to one host only';
  if (form.loadBalanced && (hosts.length > 1 || form.replicaSet.trim()))
    return 'A load-balanced connection has one host and no replica set';
  if (['SCRAM-SHA-256', 'SCRAM-SHA-1', 'default'].includes(form.auth) && !form.username.trim())
    return 'Add the user name';
  for (const key of [
    'wtimeoutMS',
    'connectTimeoutMS',
    'socketTimeoutMS',
    'serverSelectionTimeoutMS',
  ] as const) {
    if (form[key].trim() && !/^\d+$/.test(form[key].trim()))
      return 'Timeouts are numbers of milliseconds';
  }
  if (
    form.readPreferenceTags.trim() &&
    !/^[^:,]+:[^:,]*(,[^:,]+:[^:,]*)*$/.test(form.readPreferenceTags.trim())
  )
    return 'Write read preference tags as name:value pairs separated by commas';
  return undefined;
}

/** The connection documents of a workspace, grouped by folder (no folder first), by name. */
export function connectionFolders<T extends { name: string; value: unknown }>(
  documents: readonly T[],
): { folder: string; connections: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const document of [...documents].sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = connectionValue(document.value).folder?.trim() ?? '';
    groups.set(folder, [...(groups.get(folder) ?? []), document]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, connections]) => ({ folder, connections }));
}

/** A stored value read defensively: documents can come from Git or older versions. */
export function connectionValue(value: unknown): MongoConnectionValue {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (key: string) =>
    typeof source[key] === 'string' ? (source[key] as string) : undefined;
  return {
    uri: text('uri') ?? '',
    ...(text('password') ? { password: text('password') } : {}),
    ...(text('caPem') ? { caPem: text('caPem') } : {}),
    ...(text('certPem') ? { certPem: text('certPem') } : {}),
    ...(text('keyPem') ? { keyPem: text('keyPem') } : {}),
    ...(text('folder') ? { folder: text('folder') } : {}),
    ...(text('color') ? { color: text('color') } : {}),
    ...(source['readOnly'] === true ? { readOnly: true } : {}),
  };
}

/** Whether a text is only a vault reference. */
export function isVaultReference(text: string | undefined) {
  return !!text && /^\{\{\s*vault:[^{}]+\}\}$/.test(text.trim());
}
