/** Query strings and path variables of a URL, encoded as Postman does. */

import type { KeyValue } from './requests';

/** Percent-encodes query text but keeps `{{variable}}` placeholders so they still resolve. */
export function encodeQueryPart(value: string): string {
  return String(value)
    .split(/(\{\{[^{}]+\}\})/)
    .map((part) => (/^\{\{[^{}]+\}\}$/.test(part) ? part : encodeURIComponent(part)))
    .join('');
}
export const row = (key = '', value = ''): KeyValue => ({ key, value, enabled: true });
function decodeQueryPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
/**
 * Splits the query of a saved URL into editable rows. URLs whose query would not be written
 * back identically (fragments, `+`, keys without `=`, unusual escapes) stay whole.
 */
export function splitQuery(url: string): { url: string; query: KeyValue[] } {
  const index = url.indexOf('?');
  if (index < 0 || url.includes('#') || index === url.length - 1) return { url, query: [] };
  const query: KeyValue[] = [];
  for (const part of url.slice(index + 1).split('&')) {
    const separator = part.indexOf('=');
    if (separator < 1) return { url, query: [] };
    const rawKey = part.slice(0, separator);
    const rawValue = part.slice(separator + 1);
    const key = decodeQueryPart(rawKey);
    const value = decodeQueryPart(rawValue);
    if (key === undefined || value === undefined) return { url, query: [] };
    if (encodeQueryPart(key) !== rawKey || encodeQueryPart(value) !== rawValue)
      return { url, query: [] };
    query.push(row(key, value));
  }
  return { url: url.slice(0, index), query };
}
/** Names of the `:name` path segments of a URL, in order and without repeats, as Postman. */
export function pathVariableNames(url: string): string[] {
  const address = url.split(/[?#]/, 1)[0];
  const scheme = address.indexOf('://');
  const slash = scheme < 0 ? 0 : address.indexOf('/', scheme + 3);
  if (slash < 0) return [];
  const names = address
    .slice(slash)
    .split('/')
    .filter((segment) => segment.length > 1 && segment.startsWith(':'))
    .map((segment) => segment.slice(1));
  return [...new Set(names)];
}
/** The path variables of a URL with the values already entered, one row per name. */
export function pathVariableRows(url: string, rows: readonly KeyValue[]): KeyValue[] {
  return pathVariableNames(url).map((key) => ({
    key,
    value: rows.find((row) => row.key === key)?.value ?? '',
    enabled: true,
  }));
}
