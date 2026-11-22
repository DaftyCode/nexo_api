/**
 * Redis and Valkey in the interface (DB-35): keys and values as the driver gives them (text,
 * or bytes as `{$t: 'binary'}`), the keys grouped by a separator as a tree, expiries, the
 * answers of the console written as redis-cli writes them, and what `INFO` and
 * `CLIENT LIST` say.
 */

/** A key or a value: text, or bytes that are not UTF-8. */
export type KvText = string | { $t: string; v: string };

export interface KvKey {
  key: KvText;
  type: string;
  /** Milliseconds left; none when it never expires. */
  ttlMs?: number | null;
}

export interface KvElement {
  index?: number;
  field?: KvText;
  score?: number;
  id?: string;
  value: unknown;
}

export interface KvValue {
  key: KvText;
  type: string;
  ttlMs?: number | null;
  encoding?: string | null;
  size?: number | null;
  length?: number | null;
  value?: unknown;
  elements: KvElement[];
  cursor?: string | null;
}

export interface KvScanPage {
  keys: KvKey[];
  cursor?: string | null;
}

/** The types a key may have, as `TYPE` names them, for the filter and new keys. */
export const KV_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;

function binaryText(base64: string): string {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return base64;
  }
  return Array.from(bytes, (byte) =>
    byte >= 0x20 && byte < 0x7f && byte !== 0x5c
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, '0')}`,
  ).join('');
}

/** A key or value as text: itself, or its bytes escaped as redis-cli writes them. */
export function kvText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && '$t' in value) {
    const typed = value as { $t: string; v: unknown };
    return typed.$t === 'binary' ? binaryText(String(typed.v)) : String(typed.v);
  }
  return String(value);
}

/** Whether a value is bytes that are not text. */
export function isBinary(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { $t?: string }).$t === 'binary';
}

/** The same key, compared by what it is. */
export function sameKey(a: KvText | undefined, b: KvText | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A row of the tree of keys: a folder of a prefix, or a key. */
export interface KeyRow {
  /** The prefix of a folder (`user:42:`), or the key's own text. */
  id: string;
  label: string;
  depth: number;
  key?: KvKey;
  /** Keys under a folder, among those read. */
  count?: number;
  expanded?: boolean;
}

interface Folder {
  keys: KvKey[];
  folders: Map<string, Folder>;
  count: number;
}

/**
 * The keys read as a tree of folders by `separator` (`user:42:name` → `user` / `42` / `name`),
 * folders first and in order; only the folders in `expanded` show what they hold.
 */
export function keyRows(
  keys: readonly KvKey[],
  separator: string,
  expanded: ReadonlySet<string>,
): KeyRow[] {
  const root: Folder = { keys: [], folders: new Map(), count: 0 };
  for (const key of keys) {
    const parts = separator ? kvText(key.key).split(separator) : [kvText(key.key)];
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) folder.folders.set(part, (next = { keys: [], folders: new Map(), count: 0 }));
      next.count++;
      folder = next;
    }
    folder.keys.push(key);
  }
  const rows: KeyRow[] = [];
  const walk = (folder: Folder, prefix: string, depth: number) => {
    for (const name of [...folder.folders.keys()].sort()) {
      const inner = folder.folders.get(name)!;
      const id = `${prefix}${name}${separator}`;
      const open = expanded.has(id);
      rows.push({ id, label: name, depth, count: inner.count, expanded: open });
      if (open) walk(inner, id, depth + 1);
    }
    const sorted = [...folder.keys].sort((a, b) => kvText(a.key).localeCompare(kvText(b.key)));
    for (const key of sorted) {
      const text = kvText(key.key);
      rows.push({ id: text, label: text.slice(prefix.length) || text, depth, key });
    }
  };
  walk(root, '', 0);
  return rows;
}

/** An expiry as it reads: `∞`, `45 s`, `12 min`, `3 h`, `2 d`. */
export function ttlText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '∞';
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

/** An expiry typed by the person: seconds, or `90s`, `5m`, `2h`, `1d`. */
export function parseTtl(text: string): number | undefined {
  const found = /^\s*(\d+(?:\.\d+)?)\s*(s|m|min|h|d)?\s*$/i.exec(text);
  if (!found) return undefined;
  const units: Record<string, number> = { s: 1, m: 60, min: 60, h: 3600, d: 86400 };
  const ms = Number(found[1]) * (units[(found[2] ?? 's').toLowerCase()] ?? 1) * 1000;
  return ms > 0 ? Math.round(ms) : undefined;
}

/** An answer of the console as redis-cli writes it. */
export function replyText(reply: unknown, indent = ''): string {
  if (reply === null || reply === undefined) return '(nil)';
  if (typeof reply === 'number') return `(integer) ${reply}`;
  if (typeof reply === 'boolean') return `(boolean) ${reply}`;
  if (typeof reply === 'string') return reply.includes('\n') ? reply : `"${reply}"`;
  if (Array.isArray(reply)) {
    if (!reply.length) return '(empty array)';
    const width = String(reply.length).length;
    return reply
      .map((item, at) => {
        const number = `${String(at + 1).padStart(width)}) `;
        const inner = replyText(item, indent + ' '.repeat(number.length));
        return `${at ? indent : ''}${number}${inner}`;
      })
      .join('\n');
  }
  const object = reply as Record<string, unknown>;
  if (typeof object['error'] === 'string') return `(error) ${object['error']}`;
  if ('$t' in object) return `"${kvText(object)}"`;
  return replyText(Object.entries(object).flat(), indent);
}

/** The sections of an `INFO` answer, with their fields in order. */
export function infoSections(text: string): { name: string; fields: [string, string][] }[] {
  const sections: { name: string; fields: [string, string][] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) sections.push({ name: line.slice(2).trim(), fields: [] });
    else if (line.includes(':')) {
      if (!sections.length) sections.push({ name: 'Info', fields: [] });
      const at = line.indexOf(':');
      sections.at(-1)!.fields.push([line.slice(0, at), line.slice(at + 1).trim()]);
    }
  }
  return sections;
}

/** The clients of `CLIENT LIST`, each one by its fields (`id`, `addr`, `name`, `age`, `cmd`…). */
export function clientList(text: string): Record<string, string>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) =>
      Object.fromEntries(
        line
          .trim()
          .split(' ')
          .map((pair) => {
            const at = pair.indexOf('=');
            return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
          }),
      ),
    );
}

/** The name a confirmation asks to type, from the backend's answer (`Type FLUSHDB to confirm it`). */
export function typedConfirmation(message: string): string | undefined {
  return /Type (.+) to confirm it/.exec(message)?.[1];
}

/** The database of a keys tab (`db3` → 3). */
export function databaseNumber(name: string | undefined): number {
  const found = /^db(\d+)$/.exec(name ?? '');
  return found ? Number(found[1]) : 0;
}
