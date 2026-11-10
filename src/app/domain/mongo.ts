/**
 * MongoDB connections: the stored document, the form that edits it and the URI both come
 * from. The URI is kept without its password, which lives in the vault.
 */

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

/** A URI split into its parts, with the password if it had one. */
export interface ParsedUri {
  form: ConnectionForm;
  password?: string;
}

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
/** Percent-encodes a user name or password; template variables stay as written. */
function encodeCredential(text: string) {
  return text
    .split(/(\{\{[^{}]*\}\})/)
    .map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part)))
    .join('');
}

/** Options the form shows in fields; the rest are kept in `extra`. */
const FORM_OPTIONS = [
  'replicaSet',
  'authMechanism',
  'authSource',
  'tls',
  'ssl',
  'tlsAllowInvalidCertificates',
  'tlsInsecure',
  'readPreference',
  'readPreferenceTags',
  'w',
  'wtimeoutMS',
  'journal',
  'connectTimeoutMS',
  'socketTimeoutMS',
  'serverSelectionTimeoutMS',
  'retryWrites',
  'directConnection',
  'loadBalanced',
];
const formOption = (key: string) =>
  FORM_OPTIONS.find((option) => option.toLowerCase() === key.toLowerCase());

/** Reads a MongoDB URI into the form. Throws an error that says what is wrong. */
export function parseMongoUri(text: string): ParsedUri {
  const uri = text.trim();
  const scheme = /^(mongodb(?:\+srv)?):\/\//i.exec(uri);
  if (!scheme) throw new Error('A MongoDB URI starts with mongodb:// or mongodb+srv://');
  const rest = uri.slice(scheme[0].length);
  const queryAt = rest.indexOf('?');
  const beforeQuery = queryAt < 0 ? rest : rest.slice(0, queryAt);
  const query = queryAt < 0 ? '' : rest.slice(queryAt + 1);
  const slash = beforeQuery.indexOf('/');
  const authority = slash < 0 ? beforeQuery : beforeQuery.slice(0, slash);
  const database = slash < 0 ? '' : decode(beforeQuery.slice(slash + 1));
  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? '' : authority.slice(0, at);
  const hostList = at < 0 ? authority : authority.slice(at + 1);
  if (!hostList) throw new Error('The URI has no host');

  // A colon outside template variables separates the password.
  let username = userinfo;
  let password: string | undefined;
  const plain = userinfo.replace(/\{\{[^{}]*\}\}/g, (match) => '_'.repeat(match.length));
  const colon = plain.indexOf(':');
  if (colon >= 0) {
    username = userinfo.slice(0, colon);
    password = decode(userinfo.slice(colon + 1));
  }
  const form: ConnectionForm = {
    ...emptyConnectionForm(),
    srv: scheme[1].toLowerCase() === 'mongodb+srv',
    hosts: hostList.split(',').join('\n'),
    database,
    username: decode(username),
    tls: scheme[1].toLowerCase() === 'mongodb+srv',
  };
  const extra: string[] = [];
  for (const pair of query.split('&').filter(Boolean)) {
    const equals = pair.indexOf('=');
    const rawKey = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? '' : decode(pair.slice(equals + 1));
    const key = formOption(rawKey);
    const yes = value === 'true';
    switch (key) {
      case 'replicaSet':
        form.replicaSet = value;
        break;
      case 'authMechanism':
        form.auth = (AUTH_CHOICES as readonly string[]).includes(value)
          ? (value as AuthChoice)
          : 'default';
        if (!(AUTH_CHOICES as readonly string[]).includes(value)) extra.push(pair);
        break;
      case 'authSource':
        form.authSource = value;
        break;
      case 'tls':
      case 'ssl':
        form.tls = yes;
        break;
      case 'tlsAllowInvalidCertificates':
      case 'tlsInsecure':
        form.allowInvalidCertificates = yes;
        if (yes) form.tls = true;
        break;
      case 'readPreference':
        form.readPreference = value;
        break;
      case 'readPreferenceTags':
        form.readPreferenceTags = value;
        break;
      case 'w':
        form.w = value;
        break;
      case 'wtimeoutMS':
      case 'connectTimeoutMS':
      case 'socketTimeoutMS':
      case 'serverSelectionTimeoutMS':
        form[key] = value;
        break;
      case 'journal':
        form.journal = yes;
        break;
      case 'retryWrites':
        form.retryWrites = value !== 'false';
        break;
      case 'directConnection':
        form.directConnection = yes;
        break;
      case 'loadBalanced':
        form.loadBalanced = yes;
        break;
      default:
        extra.push(pair);
    }
  }
  form.extra = extra.join('&');
  if (form.auth === 'none' && (form.username || password !== undefined)) form.auth = 'default';
  return password === undefined ? { form } : { form, password };
}

/** Writes the URI of a form, never with a password. */
export function formatMongoUri(form: ConnectionForm): string {
  const hosts = form.hosts
    .split(/[\n,]/)
    .map((host) => host.trim())
    .filter(Boolean);
  const signsIn = form.auth !== 'none' && form.username.trim();
  const userinfo = signsIn ? `${encodeCredential(form.username.trim())}@` : '';
  const options: string[] = [];
  const add = (key: string, value: string | boolean) => {
    options.push(`${key}=${typeof value === 'string' ? encodeURIComponent(value) : value}`);
  };
  if (form.replicaSet.trim()) add('replicaSet', form.replicaSet.trim());
  if (form.auth !== 'none' && form.auth !== 'default') add('authMechanism', form.auth);
  if (form.auth !== 'none' && form.authSource.trim()) add('authSource', form.authSource.trim());
  // `mongodb+srv://` turns TLS on by itself.
  if (form.tls !== form.srv) add('tls', form.tls);
  if (form.tls && form.allowInvalidCertificates) add('tlsAllowInvalidCertificates', true);
  if (form.readPreference) add('readPreference', form.readPreference);
  if (form.readPreferenceTags.trim()) {
    options.push(`readPreferenceTags=${form.readPreferenceTags.trim()}`);
  }
  if (form.w.trim()) add('w', form.w.trim());
  for (const key of [
    'wtimeoutMS',
    'connectTimeoutMS',
    'socketTimeoutMS',
    'serverSelectionTimeoutMS',
  ] as const) {
    if (form[key].trim()) add(key, form[key].trim());
  }
  if (form.journal) add('journal', true);
  if (!form.retryWrites) add('retryWrites', false);
  if (form.directConnection) add('directConnection', true);
  if (form.loadBalanced) add('loadBalanced', true);
  const extra = form.extra.trim().replace(/^[?&]+/, '');
  if (extra) options.push(extra);
  const path = form.database.trim() ? encodeURIComponent(form.database.trim()) : '';
  const query = options.length ? `?${options.join('&')}` : '';
  return `${form.srv ? 'mongodb+srv' : 'mongodb'}://${userinfo}${hosts.join(',')}/${path}${query}`;
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

/** A connection exported by MongoDB Compass ("Export Saved Connections"). */
export interface ImportedConnection {
  name: string;
  uri: string;
  password?: string;
  color?: string;
}

/**
 * Reads a file of connections exported by MongoDB Compass. Passwords of an unencrypted
 * export come out of the URI; those of an encrypted one cannot be read and must be typed.
 */
export function parseCompassExport(text: string): ImportedConnection[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON');
  }
  const file = data as { type?: unknown; connections?: unknown };
  if (file?.type !== 'Compass Connections' || !Array.isArray(file.connections))
    throw new Error('The file is not an export of MongoDB Compass connections');
  return file.connections.flatMap((entry: unknown, index: number) => {
    const connection = entry as {
      connectionOptions?: { connectionString?: unknown };
      favorite?: { name?: unknown; color?: unknown };
    };
    const uri = connection?.connectionOptions?.connectionString;
    if (typeof uri !== 'string') return [];
    let parsed: ParsedUri;
    try {
      parsed = parseMongoUri(uri);
    } catch {
      return [];
    }
    const name = connection.favorite?.name;
    const color = /^color(\d+)$/.exec(String(connection.favorite?.color ?? ''));
    return [
      {
        name: typeof name === 'string' && name.trim() ? name.trim() : `Connection ${index + 1}`,
        uri: formatMongoUri(parsed.form),
        ...(parsed.password !== undefined ? { password: parsed.password } : {}),
        ...(color
          ? {
              color:
                CONNECTION_COLORS[(Math.max(1, Number(color[1])) - 1) % CONNECTION_COLORS.length],
            }
          : {}),
      },
    ];
  });
}
