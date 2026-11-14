/**
 * The connection form of the database section: a flat model for Signal Forms, read from a
 * stored connection and written back to one. Secrets typed in it go to the vault.
 */
import {
  ConnectionType,
  DbConnectionValue,
  TlsMode,
  autoCommits,
  connectionType,
  isVaultReference,
  readDbConnection,
} from './connection';
import { engineProfile } from './engines';
import { ParsedUrl, formatDbUrl } from './url';

export interface PropertyRow {
  name: string;
  value: string;
}

export interface DbForm {
  driver: string;
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  /** Typed here; blank keeps what the vault has. */
  password: string;
  tlsMode: TlsMode;
  caPem: string;
  certPem: string;
  /** Typed here; blank keeps what the vault has. */
  keyPem: string;
  params: PropertyRow[];
  type: ConnectionType;
  folder: string;
  color: string;
  description: string;
  readOnly: boolean;
  autoCommit: boolean;
  /** 0: no limit. */
  timeoutSeconds: number;
  /** A URL pasted to fill the form. */
  url: string;
}

/** A new connection of an engine, with its usual values. */
export function emptyDbForm(driver: string, name = ''): DbForm {
  const profile = engineProfile(driver, name);
  return {
    driver,
    name: name || profile.name,
    host: profile.defaultHost,
    port: profile.defaultPort ? String(profile.defaultPort) : '',
    database: profile.defaultDatabase,
    user: profile.defaultUser,
    password: '',
    tlsMode: 'disable',
    caPem: '',
    certPem: '',
    keyPem: '',
    params: [],
    type: 'development',
    folder: '',
    color: '',
    description: '',
    readOnly: false,
    autoCommit: true,
    timeoutSeconds: 0,
    url: '',
  };
}

/** The form of a saved connection. Its secrets stay in the vault: the form shows them blank. */
export function formOf(name: string, stored: unknown): DbForm {
  const value = readDbConnection(stored);
  return {
    ...emptyDbForm(value.driver, name),
    name,
    host: value.host ?? '',
    port: value.port === undefined ? '' : String(value.port),
    database: value.database ?? '',
    user: value.user ?? '',
    tlsMode: value.tls?.mode ?? 'disable',
    caPem: value.tls?.caPem ?? '',
    certPem: value.tls?.certPem ?? '',
    params: Object.entries(value.params ?? {}).map(([key, text]) => ({ name: key, value: text })),
    type: connectionType(value),
    folder: value.folder ?? '',
    color: value.color ?? '',
    description: value.description ?? '',
    readOnly: !!value.readOnly,
    autoCommit: autoCommits(value),
    timeoutSeconds: value.timeoutSeconds ?? 0,
  };
}

/** The form filled from a pasted URL; its password moves to the password field. */
export function withUrl(form: DbForm, parsed: ParsedUrl): DbForm {
  const params = new Map(form.params.map((row) => [row.name, row.value]));
  for (const [key, text] of Object.entries(parsed.params)) params.set(key, text);
  return {
    ...form,
    driver: parsed.driver,
    host: parsed.host,
    port: parsed.port || form.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password ?? form.password,
    tlsMode: parsed.tlsMode ?? form.tlsMode,
    params: [...params].map(([key, text]) => ({ name: key, value: text })),
    url: '',
  };
}

/** The URL the form shows, without the password. */
export function formUrl(form: DbForm): string {
  return formatDbUrl(form);
}

/** What keeps the form from being tested or saved, as a message key; empty when nothing. */
export function formProblem(form: DbForm): string {
  if (!form.driver) return 'Choose the database of the connection';
  if (!form.name.trim()) return 'Give the connection a name';
  if (!form.host.trim() && !form.database.trim())
    return 'A connection needs a server or a database';
  const port = form.port.trim();
  if (port && !port.includes('{{') && !(/^\d+$/.test(port) && +port >= 1 && +port <= 65535))
    return 'The port is a number from 1 to 65535';
  if (form.timeoutSeconds < 0 || form.timeoutSeconds > 3600)
    return 'The statement time limit is from 1 to 3600 seconds';
  const allowed = engineProfile(form.driver).properties.map((property) => property.name);
  const names = form.params.map((row) => row.name.trim()).filter(Boolean);
  if (allowed.length && names.some((name) => !allowed.includes(name)))
    return 'Choose the driver settings from its list';
  if (new Set(names).size !== names.length) return 'Each driver setting appears once';
  return '';
}

/**
 * The value to store from the form. `stored` keeps the vault references of the saved
 * connection; secrets typed in the form are written by the use cases, which replace them.
 */
export function valueOf(form: DbForm, stored?: DbConnectionValue): DbConnectionValue {
  const text = (value: string) => value.trim() || undefined;
  const port = form.port.trim();
  const params = Object.fromEntries(
    form.params
      .filter((row) => row.name.trim() && row.value.trim())
      .map((row) => [row.name.trim(), row.value.trim()]),
  );
  const tls =
    form.tlsMode === 'disable' && !form.caPem.trim() && !form.certPem.trim()
      ? undefined
      : {
          mode: form.tlsMode,
          ...(form.caPem.trim() ? { caPem: form.caPem.trim() } : {}),
          ...(form.certPem.trim() ? { certPem: form.certPem.trim() } : {}),
          ...(form.certPem.trim() && stored?.tls?.keyPem ? { keyPem: stored.tls.keyPem } : {}),
        };
  const value: DbConnectionValue = {
    driver: form.driver,
    host: text(form.host),
    port: port ? (/^\d+$/.test(port) ? Number(port) : port) : undefined,
    database: text(form.database),
    user: text(form.user),
    password: stored?.password,
    ...(Object.keys(params).length ? { params } : {}),
    tls,
    ...(form.type !== 'development' ? { type: form.type } : {}),
    folder: text(form.folder),
    color: text(form.color),
    description: text(form.description),
    ...(form.readOnly ? { readOnly: true } : {}),
    ...(form.autoCommit !== (form.type !== 'production') ? { autoCommit: form.autoCommit } : {}),
    ...(form.timeoutSeconds > 0 ? { timeoutSeconds: form.timeoutSeconds } : {}),
    ...(stored?.filters?.length ? { filters: stored.filters } : {}),
  };
  for (const key of Object.keys(value) as (keyof DbConnectionValue)[])
    if (value[key] === undefined) delete value[key];
  return value;
}

/** The secrets typed in the form, to put in the vault; a vault reference is kept as it is. */
export function typedSecrets(form: DbForm): { password?: string; keyPem?: string } {
  return {
    ...(form.password ? { password: form.password } : {}),
    ...(form.keyPem.trim() && form.certPem.trim() ? { keyPem: form.keyPem.trim() } : {}),
  };
}

export { isVaultReference };
