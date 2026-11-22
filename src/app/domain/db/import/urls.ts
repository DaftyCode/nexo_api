/**
 * A list of engine URLs pasted or read from a text file, one per line (`#` starts a comment):
 * each one a connection, read as the connection form reads a URL. A password in a URL is left
 * out, and the connection asks for it.
 */
import { formatDbUrl, parseDbUrl } from '../url';
import { ConnectionImport, ImportBuilder } from './builder';

export function readUrlList(source: string, builder: ImportBuilder): ConnectionImport {
  for (const line of source.split(/\r?\n/)) {
    const url = line.trim();
    if (!url || url.startsWith('#')) continue;
    let parsed;
    try {
      parsed = parseDbUrl(url);
    } catch {
      builder.skip(url.replace(/\/\/[^@/]*@/, '//'), 'url');
      continue;
    }
    const name = formatDbUrl({
      driver: parsed.driver,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      tlsMode: 'disable',
      params: [],
    }).replace(/^[a-z]+:\/\//i, '');
    const sqlite = parsed.driver === 'sqlite';
    builder.connection(name || url, {
      driver: parsed.driver,
      host: sqlite ? undefined : parsed.host,
      port: parsed.port || undefined,
      database: parsed.database || undefined,
      user: parsed.user || undefined,
      params: Object.keys(parsed.params).length ? parsed.params : undefined,
      tls: parsed.tlsMode && parsed.tlsMode !== 'disable' ? { mode: parsed.tlsMode } : undefined,
    });
  }
  return builder.result();
}
