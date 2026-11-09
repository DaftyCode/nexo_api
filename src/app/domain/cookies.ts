/** A cookie of the workspace jar, as the engine lists it. */
export interface StoredCookie {
  name: string;
  value: string;
  /** Host, or the domain whose subdomains also receive it (`hostOnly` false). */
  domain: string;
  hostOnly: boolean;
  path: string;
  /** Milliseconds since 1970; `null` for a session cookie, kept until it is deleted. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

/** What identifies a cookie in its jar. */
export interface CookieKey {
  domain: string;
  path: string;
  name: string;
}

export type SameSite = '' | 'Strict' | 'Lax' | 'None';

/** A cookie being added or edited in the cookie manager. */
export interface CookieDraft {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** `YYYY-MM-DDTHH:mm` in local time, as a `datetime-local` input; empty for a session cookie. */
  expires: string;
  includeSubdomains: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
}

/** The fields of `cookies.set` for a draft. */
export interface CookieChange {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  includeSubdomains?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** The cookies of one domain, as the manager groups them. */
export interface CookieDomain {
  domain: string;
  cookies: StoredCookie[];
}

export function emptyCookie(domain = ''): CookieDraft {
  return {
    name: '',
    value: '',
    domain,
    path: '/',
    expires: '',
    includeSubdomains: false,
    secure: false,
    httpOnly: false,
    sameSite: '',
  };
}

export function cookieKey(cookie: StoredCookie): CookieKey {
  return { domain: cookie.domain, path: cookie.path, name: cookie.name };
}

export function sameCookie(a: CookieKey, b: CookieKey) {
  return a.domain === b.domain && a.path === b.path && a.name === b.name;
}

/** A time as a `datetime-local` input shows it, in local time. */
export function localDateTime(time: number) {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function cookieDraft(cookie: StoredCookie): CookieDraft {
  const sameSite = ['Strict', 'Lax', 'None'].includes(cookie.sameSite ?? '')
    ? (cookie.sameSite as SameSite)
    : '';
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires === null ? '' : localDateTime(cookie.expires),
    includeSubdomains: !cookie.hostOnly,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
  };
}

/** The domains with their cookies, sorted, keeping those whose domain or name has `filter`. */
export function cookieDomains(cookies: readonly StoredCookie[], filter = ''): CookieDomain[] {
  const needle = filter.trim().toLowerCase();
  const domains = new Map<string, StoredCookie[]>();
  for (const cookie of cookies) {
    if (
      needle &&
      !cookie.domain.toLowerCase().includes(needle) &&
      !cookie.name.toLowerCase().includes(needle)
    )
      continue;
    domains.set(cookie.domain, [...(domains.get(cookie.domain) ?? []), cookie]);
  }
  return [...domains.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, list]) => ({
      domain,
      cookies: list.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name)),
    }));
}

/** The first problem of a cookie name: a token of RFC 6265, as the engine checks it. */
export function cookieNameError(name: string): string | undefined {
  if (!name.trim()) return 'The cookie needs a name';
  if (/[^\x21-\x7e]|[()<>@,;:\\"/[\]?={}]/.test(name.trim()))
    return 'The name cannot have spaces or ( ) < > @ , ; : \\ " / [ ] ? = { }';
  return undefined;
}

export function cookieValueError(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  return /[;\x00-\x1f\x7f]/.test(value) ? 'The value cannot have ; or line breaks' : undefined;
}

/** A host name or an IP address, without scheme, port or path. */
export function cookieDomainError(domain: string): string | undefined {
  const host = domain.trim().replace(/^\./, '');
  if (!host) return 'The cookie needs a domain';
  if (!/^(\[[0-9a-f:.]+\]|[^\s/\\@?#:[\]]+)$/i.test(host))
    return 'Write only the domain, such as api.example.com, without http:// or a port';
  return undefined;
}

export function cookiePathError(path: string): string | undefined {
  const value = path.trim();
  return value && (!value.startsWith('/') || /[\s;]/.test(value))
    ? 'The path starts with / and has no spaces or ;'
    : undefined;
}

export function cookieExpiresError(expires: string, now: number): string | undefined {
  if (!expires) return undefined;
  const time = new Date(expires).getTime();
  if (Number.isNaN(time)) return 'Choose a valid date';
  return time <= now ? 'The expiry date has already passed' : undefined;
}

/** Whether the domain is an IP address, which has no subdomains. */
export function isIpAddress(domain: string) {
  const host = domain.trim().replace(/^\./, '');
  return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** The fields the engine receives for a draft; it checks them again. */
export function cookieChange(draft: CookieDraft): CookieChange {
  return {
    name: draft.name.trim(),
    value: draft.value.trim(),
    domain: draft.domain.trim().replace(/^\./, '').toLowerCase(),
    path: draft.path.trim() || '/',
    ...(draft.expires ? { expires: new Date(draft.expires).getTime() } : {}),
    ...(draft.includeSubdomains && !isIpAddress(draft.domain) ? { includeSubdomains: true } : {}),
    ...(draft.secure ? { secure: true } : {}),
    ...(draft.httpOnly ? { httpOnly: true } : {}),
    ...(draft.sameSite ? { sameSite: draft.sameSite } : {}),
  };
}
