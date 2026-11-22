/**
 * Proxy profiles (`proxy-profile` documents, DB-25): an HTTP or SOCKS5 proxy that requests,
 * protocols and database connections choose by name in «Connect through» instead of writing
 * it again. The document says where and as whom; the password is a vault secret it names.
 */
export type ProxyProtocol = 'http' | 'socks5';

export interface ProxyProfile {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  /** Empty: the usual port of its kind (`proxyPort`). */
  port: string;
  username: string;
  /** SOCKS5: the proxy resolves the names (`socks5h`). */
  remoteDns: boolean;
  /** Whether a password is kept for it. */
  hasPassword: boolean;
}

/** The vault secret with the password of profile `id`. */
export const proxySecret = (id: string) => `proxy-${id}`;

const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

/** A profile from its document; anything else reads as none. */
export function readProxyProfile(document: {
  id: string;
  kind: string;
  name: string;
  value?: unknown;
}): ProxyProfile | undefined {
  if (document.kind !== 'proxy-profile') return undefined;
  const value = (document.value ?? {}) as Record<string, unknown>;
  const protocol = value['protocol'] === 'http' ? 'http' : 'socks5';
  return {
    id: document.id,
    name: document.name,
    protocol,
    host: text(value['host']),
    port: text(value['port']),
    username: text(value['username']),
    remoteDns: value['remoteDns'] === true,
    hasPassword: !!text(value['secret']),
  };
}

/** The port a profile reaches, its usual one when it names none. */
export const proxyPort = (profile: ProxyProfile) =>
  profile.port || (profile.protocol === 'http' ? '8080' : '1080');

/** What the person fills in: a password typed now goes to the vault; blank keeps the stored. */
export interface ProxyProfileForm {
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  remoteDns: boolean;
}

export function emptyProxyForm(): ProxyProfileForm {
  return {
    name: '',
    protocol: 'socks5',
    host: '',
    port: '',
    username: '',
    password: '',
    remoteDns: true,
  };
}

export function proxyForm(profile: ProxyProfile): ProxyProfileForm {
  return { ...emptyProxyForm(), ...profile, password: '' };
}

/** What keeps a profile from being saved, as a message; `undefined` when nothing. */
export function proxyProblem(form: ProxyProfileForm): string | undefined {
  if (!form.host.trim() || /\s/.test(form.host.trim())) return 'Enter the host of the proxy';
  const port = form.port.trim();
  if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    return 'Invalid proxy port';
  return undefined;
}

/** The document value of a profile; `password` when one is kept for its user. */
export function proxyProfileValue(id: string, form: ProxyProfileForm, password: boolean) {
  const username = form.username.trim();
  return {
    protocol: form.protocol,
    host: form.host.trim(),
    ...(form.port.trim() ? { port: Number(form.port.trim()) } : {}),
    ...(username ? { username } : {}),
    ...(username && password ? { secret: proxySecret(id) } : {}),
    ...(form.protocol === 'socks5' ? { remoteDns: form.remoteDns } : {}),
  };
}
