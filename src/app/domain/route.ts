/**
 * How a request or a connection reaches its server: directly, through an HTTP proxy
 * (`CONNECT`), a SOCKS5 proxy (the name resolved here or by the proxy) or an SSH tunnel of a
 * saved profile. It travels as `route` in the transport settings, which requests keep as JSON
 * text; requests saved before routes keep an older `proxy` there, read as one. Collections
 * and folders keep theirs as `nexoRoute`, and a request or folder without a way of its own
 * inherits the one of its nearest folder or collection (`inherit`), as auth does.
 */
export type RouteVia = 'inherit' | 'direct' | 'http' | 'socks5' | 'ssh';

/** A route as a form edits it: every field there, the ones its way does not use empty. */
export interface Route {
  via: RouteVia;
  host: string;
  port: string;
  username: string;
  password: string;
  /** SOCKS5: the proxy resolves the name (`socks5h`). */
  remoteDns: boolean;
  /** SSH: the id of the profile; a proxy: the id of a proxy profile, or none when written. */
  profile: string;
}

/** A route as it is stored and sent: only the fields its way uses. Inheriting stores none. */
export interface StoredRoute {
  via: Exclude<RouteVia, 'inherit'>;
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  remoteDns?: boolean;
  profile?: string;
}

export const ROUTE_VIAS: readonly RouteVia[] = ['inherit', 'direct', 'http', 'socks5', 'ssh'];

export function emptyRoute(via: RouteVia = 'direct'): Route {
  return {
    via,
    host: '',
    port: '',
    username: '',
    password: '',
    remoteDns: true,
    profile: '',
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

/**
 * A route from what was stored; anything unknown reads as direct, and nothing stored reads
 * as `absent` (`inherit` where there is a parent to inherit from).
 */
export function readRoute(value: unknown, absent: RouteVia = 'direct'): Route {
  if (value === undefined || value === null) return emptyRoute(absent);
  const source = record(value);
  const via = ROUTE_VIAS.find((each) => each === source['via']) ?? 'direct';
  return {
    via,
    host: text(source['host']),
    port: text(source['port']),
    username: text(source['username']),
    password: typeof source['password'] === 'string' ? source['password'] : '',
    remoteDns: source['remoteDns'] !== false,
    profile: text(source['profile']),
  };
}

/**
 * What is kept of a route: only the fields its way uses, and nothing when it inherits or,
 * with nothing to inherit from, goes directly.
 */
export function storedRoute(route: Route): StoredRoute | undefined {
  switch (route.via) {
    case 'inherit':
    case 'direct':
      return undefined;
    case 'ssh':
      return { via: 'ssh', profile: route.profile.trim() };
    default: {
      if (route.profile.trim()) return { via: route.via, profile: route.profile.trim() };
      const stored: StoredRoute = { via: route.via, host: route.host.trim() };
      if (route.port.trim()) stored.port = route.port.trim();
      if (route.username.trim()) {
        stored.username = route.username.trim();
        stored.password = route.password;
      }
      if (route.via === 'socks5') stored.remoteDns = route.remoteDns;
      return stored;
    }
  }
}

/**
 * What a request or a folder keeps of its route: nothing when it inherits, so that going
 * directly is kept too and overrides the way of the folder or collection above it.
 */
export function ownRoute(route: Route): StoredRoute | undefined {
  return route.via === 'direct' ? { via: 'direct' } : storedRoute(route);
}

/** The older `proxy` setting (`{protocol, host, port, username, password, uri, disabled}`). */
function olderProxy(proxy: Record<string, unknown>): Route {
  if (proxy['disabled'] === true) return emptyRoute();
  let protocol = text(proxy['protocol']);
  let host = text(proxy['host']);
  let port = text(proxy['port']);
  const uri = text(proxy['uri']);
  if (uri) {
    try {
      const url = new URL(uri);
      protocol = url.protocol.replace(':', '');
      host = url.hostname.replace(/^\[|\]$/g, '');
      port = url.port;
    } catch {
      return emptyRoute();
    }
  }
  return readRoute({
    via: protocol.startsWith('socks5') ? 'socks5' : 'http',
    host,
    port,
    username: proxy['username'],
    password: proxy['password'],
    remoteDns: protocol === 'socks5h',
  });
}

/** Transport settings kept as JSON text, as an object; text that is not one reads as none. */
function parsed(transport: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(transport.trim() || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The route of a request's transport settings, kept as JSON text; none inherits. */
export function routeOf(transport: string): Route {
  const settings = parsed(transport) ?? {};
  if (settings['route'] !== undefined) return readRoute(settings['route']);
  if (settings['proxy'] !== undefined) return olderProxy(record(settings['proxy']));
  return emptyRoute('inherit');
}

/**
 * The transport settings with `route` in place of whatever route or proxy they had; the rest
 * (TLS, client certificates) stays. An inherited route leaves no `route` at all. Text that
 * is not a JSON object is returned as it was, for the person to fix in its editor.
 */
export function withRoute(transport: string, route: Route): string {
  const settings = parsed(transport);
  if (!settings) return transport;
  const { route: _route, proxy: _proxy, ...rest } = settings;
  const stored = ownRoute(route);
  const result = stored ? { ...rest, route: stored } : rest;
  return Object.keys(result).length ? JSON.stringify(result, null, 2) : '{}';
}

/** What a route lacks to connect through, as a message; `undefined` when it is complete. */
export function routeProblem(route: Route): string | undefined {
  if (route.via === 'inherit' || route.via === 'direct') return undefined;
  if (route.via === 'ssh') {
    return route.profile ? undefined : 'Choose the SSH profile to connect through';
  }
  if (route.profile.trim()) return undefined;
  if (!route.host.trim()) return 'Enter the host of the proxy';
  const port = route.port.trim();
  if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    return 'Invalid proxy port';
  }
  return undefined;
}
