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
  const hidden = Array.isArray(source['mcpHidden'])
    ? source['mcpHidden'].filter(
        (name): name is string => typeof name === 'string' && !!name.trim(),
      )
    : [];
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
    ...(source['askPassword'] === true ? { askPassword: true } : {}),
    ...(source['pgpass'] === true && source['askPassword'] !== true ? { pgpass: true } : {}),
    ...(source['mcp'] === true ? { mcp: true } : {}),
    ...(source['mcp'] === true && hidden.length ? { mcpHidden: hidden } : {}),
  };
}
