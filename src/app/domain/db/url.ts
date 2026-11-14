/**
 * The URLs of the engines (`postgresql://user:password@host:5432/db?sslmode=require`, with an
 * optional `jdbc:` prefix): read into the form, the password taken out of them, and written
 * back without it. `{{variables}}` may stand anywhere.
 */
import { TlsMode } from './connection';
import { EngineProfile, engineOfScheme, engineProfile, tlsModeOf, tlsParameterOf } from './engines';

/** What a URL fills in the form. */
export interface ParsedUrl {
  driver: string;
  host: string;
  port: string;
  database: string;
  user: string;
  /** The password the URL carried, which goes to the vault and never into the form's URL. */
  password?: string;
  tlsMode?: TlsMode;
  params: Record<string, string>;
  /** Query parameters the driver does not accept, left out. */
  ignored: string[];
}

function decode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Encodes what a URL part cannot hold as is, but keeps `{{variables}}` readable. */
function encode(text: string) {
  return text
    .split(/(\{\{[^{}]*\}\})/)
    .map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part)))
    .join('');
}

/** Splits `host:port`, `[::1]:port` or `{{host}}:{{port}}`. */
function hostAndPort(authority: string): { host: string; port: string } {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    const port = authority.slice(end + 1).replace(/^:/, '');
    return { host: authority.slice(0, end + 1), port };
  }
  // The last colon outside a variable.
  let depth = 0;
  let colon = -1;
  for (let index = 0; index < authority.length; index++) {
    if (authority.startsWith('{{', index)) [depth, index] = [depth + 1, index + 1];
    else if (authority.startsWith('}}', index))
      [depth, index] = [Math.max(0, depth - 1), index + 1];
    else if (authority[index] === ':' && !depth) colon = index;
  }
  if (colon < 0) return { host: authority, port: '' };
  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

/**
 * Reads an engine URL. Throws when it is not one: `modules` are the ids of the catalog, so a
 * module the form does not know is read by its scheme too.
 */
export function parseDbUrl(text: string, modules: readonly string[] = []): ParsedUrl {
  const trimmed = text.trim().replace(/^jdbc:/i, '');
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(trimmed);
  if (!match) throw new Error('Paste a URL such as postgresql://user@host:5432/database');
  const driver = engineOfScheme(match[1], modules);
  if (!driver) throw new Error('Nexo has no module for the database of this URL');
  const profile = engineProfile(driver);
  let rest = match[2];
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const question = rest.indexOf('?');
  const query = question >= 0 ? rest.slice(question + 1) : '';
  if (question >= 0) rest = rest.slice(0, question);
  const slash = rest.indexOf('/');
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const database = slash >= 0 ? decode(rest.slice(slash + 1)) : '';
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : '';
  const colon = userinfo.indexOf(':');
  const parsed: ParsedUrl = {
    driver,
    ...hostAndPort(at >= 0 ? authority.slice(at + 1) : authority),
    database,
    user: decode(colon >= 0 ? userinfo.slice(0, colon) : userinfo),
    params: {},
    ignored: [],
  };
  if (colon >= 0) parsed.password = decode(userinfo.slice(colon + 1));
  for (const pair of query.split('&').filter(Boolean)) {
    const equals = pair.indexOf('=');
    const name = decode(equals >= 0 ? pair.slice(0, equals) : pair);
    const value = decode((equals >= 0 ? pair.slice(equals + 1) : '').replace(/\+/g, ' '));
    readParameter(parsed, profile, name, value);
  }
  return parsed;
}

function readParameter(parsed: ParsedUrl, profile: EngineProfile, name: string, value: string) {
  const lower = name.toLowerCase();
  if (lower === profile.tlsParameter) {
    const mode = tlsModeOf(value);
    if (mode) parsed.tlsMode = mode;
    else parsed.ignored.push(name);
  } else if (lower === 'user' || lower === 'username') parsed.user = value;
  else if (lower === 'password') parsed.password = value;
  else if (lower === 'dbname' || lower === 'database') parsed.database = value;
  else if (lower === 'host') parsed.host = value;
  else if (lower === 'port') parsed.port = value;
  else if (profile.properties.some((property) => property.name === name))
    parsed.params[name] = value;
  else parsed.ignored.push(name);
}

/** What a URL is written from. */
export interface UrlParts {
  driver: string;
  host: string;
  port: string;
  database: string;
  user: string;
  tlsMode: TlsMode;
  params: readonly { name: string; value: string }[];
}

/** The URL of a connection, without its password: to copy it or to see what is connected. */
export function formatDbUrl(parts: UrlParts): string {
  const profile = engineProfile(parts.driver);
  const user = parts.user.trim() ? `${encode(parts.user.trim())}@` : '';
  const port = parts.port.trim() ? `:${parts.port.trim()}` : '';
  const database = parts.database.trim() ? `/${encode(parts.database.trim())}` : '';
  const query = [
    ...(profile.tlsParameter && parts.tlsMode !== 'disable'
      ? [[profile.tlsParameter, tlsParameterOf(parts.tlsMode)]]
      : []),
    ...parts.params
      .filter((param) => param.name.trim() && param.value.trim())
      .map((param) => [param.name.trim(), param.value]),
  ]
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join('&');
  return `${profile.schemes[0]}://${user}${parts.host.trim()}${port}${database}${query ? `?${query}` : ''}`;
}
