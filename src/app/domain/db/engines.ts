/**
 * What the connection form knows about each engine: its default port and user, the schemes
 * of its URLs, the TLS modes its driver offers, and the closed list of settings its driver
 * accepts (any other is refused by the driver, with its name).
 */
import { TLS_MODES, TlsMode } from './connection';

export interface EngineProperty {
  name: string;
  /** A message key. */
  description: string;
}

/** What the gallery of engines says of one beside its name. */
export type EngineBadge = 'popular' | 'lightweight';

export interface EngineProfile {
  /** The module id, which is also the connection's `driver`. */
  id: string;
  name: string;
  /** What it is, in a line of the gallery: a message key. */
  summary?: string;
  badge?: EngineBadge;
  /** Its database is a file of this computer: the form asks for the file, not a server. */
  file?: boolean;
  /** It also opens a folder (the files module, DB-30), and it never makes a new file. */
  folder?: boolean;
  /** What its file field is called and says, as message keys, when not SQLite's. */
  fileLabel?: string;
  fileHelp?: string;
  filePlaceholder?: string;
  defaultPort?: number;
  defaultHost: string;
  defaultDatabase: string;
  defaultUser: string;
  /** URL schemes, the first one used to write URLs. A `jdbc:` prefix is accepted too. */
  schemes: readonly string[];
  /** The query parameter of its URLs that carries the TLS mode, if any (read without its
   * dashes and underscores and in any case: `ssl-mode`, `sslMode`). */
  tlsParameter?: string;
  /** How its URLs write each TLS mode, when not as PostgreSQL's `sslmode`. */
  tlsValues?: Readonly<Record<TlsMode, string>>;
  tlsModes: readonly TlsMode[];
  properties: readonly EngineProperty[];
  /** What its form does not offer, said under it: a message key. */
  limits?: string;
  /** The statement that makes a schema the session's default, with its name quoted. */
  schemaStatement?: (schema: string) => string;
}

const ENGINES: Record<string, EngineProfile> = {
  postgres: {
    id: 'postgres',
    name: 'PostgreSQL',
    summary: 'db.engine.postgres',
    badge: 'popular',
    defaultPort: 5432,
    defaultHost: 'localhost',
    defaultDatabase: 'postgres',
    defaultUser: 'postgres',
    schemes: ['postgresql', 'postgres'],
    tlsParameter: 'sslmode',
    tlsModes: TLS_MODES,
    properties: [
      { name: 'application_name', description: 'db.property.application_name' },
      { name: 'options', description: 'db.property.options' },
      { name: 'search_path', description: 'db.property.search_path' },
    ],
    limits: 'db.limits.postgres',
    schemaStatement: (schema) => `SET search_path TO ${schema}`,
  },
  // SQL Server has no default schema per session (it is the user's): no schema statement.
  mssql: {
    id: 'mssql',
    name: 'SQL Server',
    summary: 'db.engine.mssql',
    badge: 'popular',
    defaultPort: 1433,
    defaultHost: 'localhost',
    defaultDatabase: 'master',
    defaultUser: 'sa',
    schemes: ['sqlserver', 'mssql'],
    tlsModes: TLS_MODES,
    properties: [
      { name: 'application_name', description: 'db.property.program_name' },
      { name: 'instance', description: 'db.property.instance' },
      { name: 'strict', description: 'db.property.strict' },
    ],
    limits: 'db.limits.mssql',
  },
  // MySQL and MariaDB: one module; a database is what other engines call a schema.
  mysql: {
    id: 'mysql',
    name: 'MySQL',
    summary: 'db.engine.mysql',
    badge: 'popular',
    defaultPort: 3306,
    defaultHost: 'localhost',
    defaultDatabase: '',
    defaultUser: 'root',
    schemes: ['mysql', 'mariadb'],
    tlsParameter: 'ssl-mode',
    tlsValues: {
      disable: 'DISABLED',
      prefer: 'PREFERRED',
      require: 'REQUIRED',
      verify: 'VERIFY_IDENTITY',
    },
    tlsModes: TLS_MODES,
    properties: [
      { name: 'charset', description: 'db.property.charset' },
      { name: 'time_zone', description: 'db.property.time_zone' },
    ],
    limits: 'db.limits.mysql',
  },
  // SQLite: a file the person chooses; the driver opens only it, without TLS or users.
  sqlite: {
    id: 'sqlite',
    name: 'SQLite',
    summary: 'db.engine.sqlite',
    badge: 'lightweight',
    file: true,
    defaultHost: '',
    defaultDatabase: '',
    defaultUser: '',
    schemes: ['sqlite'],
    tlsModes: [],
    properties: [
      { name: 'create', description: 'db.property.create' },
      { name: 'foreign_keys', description: 'db.property.foreign_keys' },
      { name: 'journal_mode', description: 'db.property.journal_mode' },
      { name: 'busy_timeout', description: 'db.property.busy_timeout' },
    ],
    limits: 'db.limits.sqlite',
  },
  // Files as tables and DuckDB databases (DB-30): a folder, files or a `.duckdb` file.
  files: {
    id: 'files',
    name: 'Files and DuckDB',
    summary: 'db.engine.files',
    file: true,
    folder: true,
    fileLabel: 'Folder, files or DuckDB database',
    fileHelp: 'db.files.help',
    filePlaceholder: 'db.files.placeholder',
    defaultHost: '',
    defaultDatabase: '',
    defaultUser: '',
    schemes: ['duckdb'],
    tlsModes: [],
    properties: [
      { name: 'delimiter', description: 'db.property.delimiter' },
      { name: 'header', description: 'db.property.header' },
      { name: 'quote', description: 'db.property.quote' },
      { name: 'encoding', description: 'db.property.encoding' },
      { name: 'sheet', description: 'db.property.sheet' },
      { name: 'json_format', description: 'db.property.json_format' },
      { name: 'all_varchar', description: 'db.property.all_varchar' },
    ],
    limits: 'db.limits.files',
  },
};

/** The profile of an engine; an engine the form does not know gets the common fields. */
export function engineProfile(id: string, name = id): EngineProfile {
  return (
    ENGINES[id] ?? {
      id,
      name,
      defaultHost: 'localhost',
      defaultDatabase: '',
      defaultUser: '',
      schemes: [id],
      tlsModes: TLS_MODES,
      properties: [],
    }
  );
}

/** The engine a URL scheme names, among the known ones and the modules of the catalog. */
export function engineOfScheme(scheme: string, modules: readonly string[] = []): string {
  const wanted = scheme.toLowerCase();
  const known = Object.values(ENGINES).find((engine) => engine.schemes.includes(wanted));
  return known?.id ?? modules.find((id) => id === wanted) ?? '';
}

/** How a URL's TLS parameter reads as a mode: PostgreSQL's `sslmode` and its synonyms. */
export function tlsModeOf(text: string): TlsMode | undefined {
  switch (text.trim().toLowerCase()) {
    case 'disable':
    case 'disabled':
    case 'allow':
    case 'false':
      return 'disable';
    case 'prefer':
    case 'preferred':
      return 'prefer';
    case 'require':
    case 'required':
    case 'true':
      return 'require';
    case 'verify-ca':
    case 'verify-full':
    case 'verify_ca':
    case 'verify_identity':
    case 'verify':
      return 'verify';
    default:
      return undefined;
  }
}

/** The value a URL's TLS parameter takes for a mode, as the engine writes it. */
export function tlsParameterOf(mode: TlsMode, profile?: EngineProfile): string {
  return profile?.tlsValues?.[mode] ?? (mode === 'verify' ? 'verify-full' : mode);
}
