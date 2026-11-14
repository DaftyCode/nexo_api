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

export interface EngineProfile {
  /** The module id, which is also the connection's `driver`. */
  id: string;
  name: string;
  defaultPort?: number;
  defaultHost: string;
  defaultDatabase: string;
  defaultUser: string;
  /** URL schemes, the first one used to write URLs. A `jdbc:` prefix is accepted too. */
  schemes: readonly string[];
  /** The query parameter of its URLs that carries the TLS mode, if any. */
  tlsParameter?: string;
  tlsModes: readonly TlsMode[];
  properties: readonly EngineProperty[];
  /** What its form does not offer, said under it: a message key. */
  limits?: string;
}

const ENGINES: Record<string, EngineProfile> = {
  postgres: {
    id: 'postgres',
    name: 'PostgreSQL',
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
    case 'allow':
    case 'false':
      return 'disable';
    case 'prefer':
      return 'prefer';
    case 'require':
    case 'true':
      return 'require';
    case 'verify-ca':
    case 'verify-full':
    case 'verify':
      return 'verify';
    default:
      return undefined;
  }
}

/** The value a URL's TLS parameter takes for a mode. */
export function tlsParameterOf(mode: TlsMode): string {
  return mode === 'verify' ? 'verify-full' : mode;
}
