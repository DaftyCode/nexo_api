/**
 * The parts of the connection form added with DB-25: how it reaches its server and what its
 * sessions do as they open and while they stay open.
 */
import { Route, StoredRoute, storedRoute } from '../../route';
import type { DbConnectionValue } from '../connection';
import type { DbForm } from '../form';

/** What keeps the session settings from being saved (DB-25), as a message key. */
export function sessionProblem(form: DbForm): string {
  const within = (value: number, low: number, high: number) =>
    value === 0 || (Number.isInteger(value) && value >= low && value <= high);
  if (form.startupQueries.length > 20) return 'A connection has up to 20 startup queries';
  if (!within(form.keepAliveSeconds, 5, 600))
    return 'Keep alive is from 5 to 600 seconds, or 0 for none';
  if (!within(form.idleMinutes, 1, 10))
    return 'Closing when unused is from 1 to 10 minutes, or 0 for ten';
  if (!within(form.connectTimeoutSeconds, 1, 120))
    return 'The time to connect is from 1 to 120 seconds, or 0 for the driver’s';
  return '';
}

/**
 * The startup queries and times kept from the form, none when it keeps the usual ones; and
 * whether MCP agents may read it (DB-32), with the columns hidden from them.
 */
export function sessionValue(form: DbForm): Partial<DbConnectionValue> {
  const queries = form.startupQueries.map((row) => row.sql.trim()).filter(Boolean);
  const hidden = form.mcpHidden
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    ...(form.mcp ? { mcp: true } : {}),
    ...(form.mcp && hidden.length ? { mcpHidden: hidden } : {}),
    ...(queries.length ? { startupQueries: queries } : {}),
    ...(queries.length && form.ignoreStartupErrors ? { ignoreStartupErrors: true } : {}),
    ...(form.keepAliveSeconds > 0 ? { keepAliveSeconds: form.keepAliveSeconds } : {}),
    ...(form.idleMinutes > 0 ? { idleMinutes: form.idleMinutes } : {}),
    ...(form.connectTimeoutSeconds > 0
      ? { connectTimeoutSeconds: form.connectTimeoutSeconds }
      : {}),
  };
}

/**
 * The route kept from the form: a SOCKS5 proxy or an SSH profile, none when it goes directly.
 * The proxy's password is the saved vault reference while its user stays; one typed in the
 * form goes to the vault (`typedSecrets`).
 */
export function connectionRoute(route: Route, stored?: StoredRoute): StoredRoute | undefined {
  if (route.via !== 'socks5' && route.via !== 'ssh') return undefined;
  const kept = storedRoute({ ...route, password: '' });
  if (kept?.via === 'socks5' && kept.username) {
    const saved = stored?.via === 'socks5' ? stored.password : undefined;
    if (saved) kept.password = saved;
    else delete kept.password;
  }
  return kept;
}
