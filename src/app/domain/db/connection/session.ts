import type { DbConnectionValue } from '../connection';

/** What a connection does as it opens and while it stays open (DB-25). */
export function sessionSettings(source: Record<string, unknown>): Partial<DbConnectionValue> {
  const whole = (key: string) => {
    const value = source[key];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? { [key]: value }
      : {};
  };
  const schema = source['defaultSchema'];
  const queries = Array.isArray(source['startupQueries'])
    ? source['startupQueries'].filter(
        (query): query is string => typeof query === 'string' && !!query.trim(),
      )
    : [];
  return {
    ...(typeof schema === 'string' && schema.trim() ? { defaultSchema: schema } : {}),
    ...(queries.length ? { startupQueries: queries } : {}),
    ...(source['ignoreStartupErrors'] === true ? { ignoreStartupErrors: true } : {}),
    ...whole('keepAliveSeconds'),
    ...whole('idleMinutes'),
    ...whole('connectTimeoutSeconds'),
  };
}
