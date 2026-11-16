/**
 * SQLite's URLs, as the JDBC driver DBeaver uses writes them (`jdbc:sqlite:C:/data/shop.db`)
 * and as others do (`sqlite:///home/ana/shop.db`): the path of the file, and the settings the
 * driver takes after `?`. `{{variables}}` may stand anywhere.
 */
import type { ParsedUrl, UrlParts } from '../url';

const SETTINGS = ['create', 'foreign_keys', 'journal_mode', 'busy_timeout'];

function decode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Whether a URL is SQLite's: `sqlite:` or `jdbc:sqlite:`. */
export function isSqliteUrl(text: string): boolean {
  return /^(jdbc:)?sqlite:/i.test(text.trim());
}

/** Reads a SQLite URL: what follows the scheme is the path, `//` and a `/` before a drive cut. */
export function parseSqliteUrl(text: string): ParsedUrl {
  let rest = text.trim().replace(/^(jdbc:)?sqlite:/i, '');
  const question = rest.indexOf('?');
  const query = question >= 0 ? rest.slice(question + 1) : '';
  if (question >= 0) rest = rest.slice(0, question);
  if (rest.startsWith('//')) rest = rest.slice(2);
  // `sqlite:///C:/data/shop.db`: the drive comes after a slash.
  if (/^\/[a-z]:[\\/]/i.test(rest)) rest = rest.slice(1);
  const parsed: ParsedUrl = {
    driver: 'sqlite',
    host: '',
    port: '',
    database: decode(rest),
    user: '',
    params: {},
    ignored: [],
  };
  for (const pair of query.split('&').filter(Boolean)) {
    const equals = pair.indexOf('=');
    const name = decode(equals >= 0 ? pair.slice(0, equals) : pair);
    const value = decode(equals >= 0 ? pair.slice(equals + 1) : '');
    if (SETTINGS.includes(name)) parsed.params[name] = value;
    else parsed.ignored.push(name);
  }
  return parsed;
}

/** The URL of a SQLite connection, as the JDBC driver writes it. */
export function formatSqliteUrl(parts: UrlParts): string {
  const query = parts.params
    .filter((param) => param.name.trim() && param.value.trim())
    .map((param) => `${param.name.trim()}=${encodeURIComponent(param.value)}`)
    .join('&');
  return `jdbc:sqlite:${parts.database.trim()}${query ? `?${query}` : ''}`;
}
