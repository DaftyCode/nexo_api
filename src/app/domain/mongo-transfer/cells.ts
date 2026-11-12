/** Values of CSV cells: written from Extended JSON, and read back with a chosen type. */
import { bsonType, dateMillis, isPlain, isoDate } from '../bson';
import { relaxed } from '../bson/shell';

/** How the text of a column is written: guessed, as a given type, or not at all. */
export type ImportType =
  | 'auto'
  | 'string'
  | 'int'
  | 'long'
  | 'double'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'objectId'
  | 'json'
  | 'skip';

export const IMPORT_TYPES: readonly ImportType[] = [
  'auto',
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'json',
  'skip',
];

/** A column of a CSV file and the field it is written to, dotted for embedded documents. */
export interface CsvColumn {
  column: string;
  field: string;
  type: ImportType;
}

/** The text of a value in a CSV cell: numbers, ids and dates plainly, the rest as JSON. */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  switch (bsonType(value)) {
    case 'Int32':
    case 'Int64':
    case 'Double':
    case 'Decimal128': {
      const wrapped = value as Record<string, unknown>;
      const key = Object.keys(wrapped)[0];
      return String(wrapped[key]);
    }
    case 'ObjectId':
      return String((value as Record<string, unknown>)['$oid']);
    case 'Date':
      return isoDate(dateMillis((value as Record<string, unknown>)['$date'])) ?? '';
    default:
      return JSON.stringify(relaxed(value));
  }
}

const INT32 = 2 ** 31;
const INTEGER = /^[-+]?\d+$/;
const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * The value of a cell as Extended JSON, by its type. `undefined` leaves the field out (an
 * empty cell, or a skipped column); a string is the reason the cell cannot be read.
 */
export function typedValue(text: string, type: ImportType): { value?: unknown; error?: string } {
  if (type === 'skip' || (text === '' && type !== 'string')) return {};
  const trimmed = text.trim();
  switch (type) {
    case 'string':
      return { value: text };
    case 'auto':
      if (trimmed === 'true' || trimmed === 'false') return { value: trimmed === 'true' };
      if (INTEGER.test(trimmed)) return integer(trimmed, false);
      if (DECIMAL.test(trimmed) && Number.isFinite(Number(trimmed)))
        return { value: { $numberDouble: String(Number(trimmed)) } };
      return { value: text };
    case 'int':
    case 'long':
      return INTEGER.test(trimmed) ? integer(trimmed, type === 'long') : { error: 'number' };
    case 'double':
      return DECIMAL.test(trimmed) && Number.isFinite(Number(trimmed))
        ? { value: { $numberDouble: String(Number(trimmed)) } }
        : { error: 'number' };
    case 'decimal':
      return DECIMAL.test(trimmed) ? { value: { $numberDecimal: trimmed } } : { error: 'number' };
    case 'bool': {
      const lower = trimmed.toLowerCase();
      if (['true', 'yes', '1'].includes(lower)) return { value: true };
      if (['false', 'no', '0'].includes(lower)) return { value: false };
      return { error: 'bool' };
    }
    case 'date': {
      const millis = /^-?\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
      return Number.isFinite(millis)
        ? { value: { $date: { $numberLong: String(millis) } } }
        : { error: 'date' };
    }
    case 'objectId':
      return /^[0-9a-fA-F]{24}$/.test(trimmed)
        ? { value: { $oid: trimmed.toLowerCase() } }
        : { error: 'objectId' };
    case 'json':
      try {
        const value: unknown = JSON.parse(text);
        return { value };
      } catch {
        return { error: 'json' };
      }
  }
}

/** An integer as Int32 when it fits, otherwise as Int64 (always Int64 with `long`). */
function integer(text: string, long: boolean): { value?: unknown; error?: string } {
  let big: bigint;
  try {
    big = BigInt(text.replace(/^\+/, ''));
  } catch {
    return { error: 'number' };
  }
  if (big < -(2n ** 63n) || big >= 2n ** 63n) return { error: 'number' };
  if (!long && big >= -BigInt(INT32) && big < BigInt(INT32))
    return { value: { $numberInt: big.toString() } };
  return { value: { $numberLong: big.toString() } };
}

/** Whether a value is a document of fields (not an Extended JSON wrapper such as `$oid`). */
export function isDocument(value: unknown): value is Record<string, unknown> {
  return isPlain(value) && bsonType(value) === 'Document';
}
