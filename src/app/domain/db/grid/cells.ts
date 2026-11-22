/**
 * How the data grid writes each value: by its class (numbers to the right, `NULL` apart,
 * binaries by their size, JSON shortened), with the formats the person chose. And the
 * viewers of the «Value» panel: JSON and XML laid out, binaries in hexadecimal, images,
 * dates in several forms.
 */
import { geometryOf, shortWkt } from '../geometry';
import { isDefault } from '../edits';
import { ResultColumn, cellText, isNull } from '../results';

export type CellClass = 'null' | 'number' | 'boolean' | 'date' | 'binary' | 'json' | 'text';

export interface GridFormats {
  /** What `NULL` is written as. */
  nullText: string;
  /** `.` or `,` between the integer and the fraction. */
  decimal: '.' | ',';
  /** Dates as the server writes them (ISO 8601), or in this computer's way. */
  dates: 'iso' | 'local';
}

export const DEFAULT_FORMATS: GridFormats = { nullText: 'NULL', decimal: '.', dates: 'iso' };

/** The formats stored as JSON, each one checked; what is missing or wrong is the default. */
export function readGridFormats(text: string | null | undefined): GridFormats {
  let stored: Partial<Record<keyof GridFormats, unknown>>;
  try {
    stored = JSON.parse(text ?? '{}') ?? {};
  } catch {
    stored = {};
  }
  return {
    nullText:
      typeof stored.nullText === 'string' && stored.nullText.length <= 20
        ? stored.nullText
        : DEFAULT_FORMATS.nullText,
    decimal: stored.decimal === ',' ? ',' : '.',
    dates: stored.dates === 'local' ? 'local' : 'iso',
  };
}

/** The class of value a typed value is, from its `$t` or its JSON type. */
export function classOf(value: unknown): CellClass {
  if (isNull(value)) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' || Array.isArray(value)) return 'text';
  const kind = (value as { $t?: unknown }).$t;
  switch (kind) {
    case 'integer':
    case 'decimal':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestamptz':
      return 'date';
    case 'binary':
      return 'binary';
    case 'json':
      return 'json';
    default:
      return 'text';
  }
}

/** Bytes of a Base64 text. */
export function base64Bytes(text: string): Uint8Array {
  try {
    const raw = atob(text);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The size a binary value has, counting what a truncated one left out. */
function binarySize(value: unknown): number {
  const typed = value as { v?: unknown; size?: unknown };
  if (typeof typed.size === 'number') return typed.size;
  const text = typeof typed.v === 'string' ? typed.v : '';
  return Math.floor((text.replace(/=+$/, '').length * 3) / 4);
}

function localDate(text: string): string {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString();
}

/** What a cell shows and how it is aligned. */
export function formatCell(
  value: unknown,
  formats: GridFormats = DEFAULT_FORMATS,
): { text: string; kind: CellClass } {
  // A cell of a new row left to its column's default (DB-13).
  if (isDefault(value)) return { text: 'DEFAULT', kind: 'null' };
  const kind = classOf(value);
  switch (kind) {
    case 'null':
      return { text: formats.nullText, kind };
    case 'number': {
      const text = cellText(value);
      return { text: formats.decimal === ',' ? text.replace('.', ',') : text, kind };
    }
    case 'binary':
      return { text: `[${byteSize(binarySize(value))}]`, kind };
    case 'json': {
      const text = cellText(value).replace(/\s+/g, ' ');
      return { text: text.length > 80 ? `${text.slice(0, 80)}…` : text, kind };
    }
    case 'date': {
      const text = cellText(value);
      const timed = (value as { $t?: string }).$t?.startsWith('timestamp');
      return { text: formats.dates === 'local' && timed ? localDate(text) : text, kind };
    }
    default: {
      // A geometry shows its WKT, shortened (DB-29).
      const spatial = (value as { $t?: unknown }).$t === 'spatial' ? geometryOf(value) : undefined;
      if (spatial) return { text: shortWkt(spatial), kind };
      const text = cellText(value);
      // One line in a cell; the whole text is in the «Value» panel.
      return {
        text: text.length > 500 ? `${text.slice(0, 500)}…` : text.replace(/\n/g, '↵'),
        kind,
      };
    }
  }
}

/** Whether a value came cut by the driver's limit, and its whole size. */
export function truncation(value: unknown): { truncated: boolean; size?: number } {
  const typed = (value ?? {}) as { truncated?: unknown; size?: unknown };
  return {
    truncated: typed.truncated === true,
    ...(typeof typed.size === 'number' ? { size: typed.size } : {}),
  };
}

/** JSON laid out with two spaces; what does not parse stays as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** XML laid out with one element per line, indented by its depth. */
export function prettyXml(text: string): string {
  const tokens = text
    .replace(/>\s+</g, '><')
    .split(/(?=<)|(?<=>)/)
    .filter((part) => part.trim());
  let depth = 0;
  return tokens
    .map((token) => {
      const closing = /^<\//.test(token);
      const opening =
        token.startsWith('<') && !closing && !/^<[?!]/.test(token) && !token.endsWith('/>');
      if (closing) depth = Math.max(0, depth - 1);
      const line = `${'  '.repeat(depth)}${token}`;
      if (opening) depth++;
      return line;
    })
    .join('\n')
    .replace(/(<([\w:-]+)[^>]*>)\n\s*([^<\n]+)\n\s*(<\/\2>)/g, '$1$3$4');
}

/** A hexadecimal dump: offset, 16 bytes and their printable characters per line. */
export function hexDump(bytes: Uint8Array, limit = 4096): string {
  const lines: string[] = [];
  for (let offset = 0; offset < Math.min(bytes.length, limit); offset += 16) {
    const chunk = [...bytes.slice(offset, offset + 16)];
    const hex = chunk.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const text = chunk
      .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${text}`);
  }
  if (bytes.length > limit) lines.push(`… ${byteSize(bytes.length - limit)}`);
  return lines.join('\n');
}

/** The image type of a binary, by its first bytes, for the viewer to draw it. */
export function imageType(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return undefined;
}

/** A date in the forms the «Value» panel shows. */
export function dateForms(text: string): { label: string; text: string }[] {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return [{ label: 'As stored', text }];
  return [
    { label: 'As stored', text },
    { label: 'ISO 8601 (UTC)', text: date.toISOString() },
    { label: 'This computer', text: date.toLocaleString() },
    { label: 'Unix time (ms)', text: String(date.getTime()) },
  ];
}

/** 100-nanosecond intervals from the Gregorian reform (1582-10-15) to 1970-01-01. */
const GREGORIAN_OFFSET = 0x01b21dd213814000n;

/**
 * When a time UUID (version 1: Cassandra's `timeuuid`) was made, in ISO 8601; nothing for
 * the other versions.
 */
export function uuidTime(text: string): string | undefined {
  const parts = /^([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(
    text.trim(),
  );
  if (!parts) return undefined;
  const ticks = BigInt(`0x${parts[3]}${parts[2]}${parts[1]}`);
  const date = new Date(Number((ticks - GREGORIAN_OFFSET) / 10000n));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The width a column starts with, in characters: its name or its longest first values. */
export function columnChars(column: ResultColumn, rows: readonly unknown[][], index: number) {
  let longest = column.name.length;
  for (const row of rows.slice(0, 50))
    longest = Math.max(longest, formatCell(row[index]).text.length);
  return Math.min(Math.max(longest, 4), 48);
}
