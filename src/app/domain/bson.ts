/**
 * BSON values as the backend sends them: canonical Extended JSON, so every type survives.
 * Here they are named, shown as the MongoDB shell writes them, converted to relaxed
 * Extended JSON, and laid out as table columns and tree rows.
 */

export { relaxed, shell, shellText } from './bson/shell';
export { summary, tableColumns, treeRows, valueAt } from './bson/views';
export type { TableColumn, TreeRow } from './bson/views';

export type BsonType =
  | 'ObjectId'
  | 'String'
  | 'Int32'
  | 'Int64'
  | 'Double'
  | 'Decimal128'
  | 'Boolean'
  | 'Date'
  | 'Null'
  | 'Undefined'
  | 'Document'
  | 'Array'
  | 'Binary'
  | 'UUID'
  | 'RegExp'
  | 'Timestamp'
  | 'MinKey'
  | 'MaxKey'
  | 'Code'
  | 'Symbol'
  | 'DBPointer';

export type Plain = Record<string, unknown>;

export function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The single `$` key of a type wrapper, such as `$oid`, or none. */
function wrapper(value: Plain): string | undefined {
  const keys = Object.keys(value);
  if (keys.length === 2 && 'scope' in value && '$code' in value) return '$code';
  return keys.length === 1 && keys[0].startsWith('$') ? keys[0] : undefined;
}

const WRAPPERS: Record<string, BsonType> = {
  $oid: 'ObjectId',
  $numberInt: 'Int32',
  $numberLong: 'Int64',
  $numberDouble: 'Double',
  $numberDecimal: 'Decimal128',
  $date: 'Date',
  $binary: 'Binary',
  $regularExpression: 'RegExp',
  $timestamp: 'Timestamp',
  $minKey: 'MinKey',
  $maxKey: 'MaxKey',
  $code: 'Code',
  $symbol: 'Symbol',
  $dbPointer: 'DBPointer',
  $undefined: 'Undefined',
};

/** The BSON type of a value in Extended JSON. */
export function bsonType(value: unknown): BsonType {
  if (value === null) return 'Null';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int32' : 'Double';
  if (Array.isArray(value)) return 'Array';
  if (!isPlain(value)) return 'Undefined';
  const key = wrapper(value);
  const type = key ? WRAPPERS[key] : undefined;
  if (type === 'Binary' && binarySubtype(value) === '04') return 'UUID';
  return type ?? 'Document';
}

/** Whether a value holds fields or elements to open. */
export function isContainer(value: unknown): value is Plain | unknown[] {
  const type = bsonType(value);
  return type === 'Document' || type === 'Array';
}

export function binarySubtype(value: Plain): string {
  const binary = value['$binary'];
  return isPlain(binary) ? String(binary['subType'] ?? '00').padStart(2, '0') : '00';
}

export function base64Bytes(text: string): number[] {
  try {
    return Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return [];
  }
}

/** A UUID's text from its binary value. */
export function uuidText(base64: string): string {
  const hex = base64Bytes(base64)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds since 1970 of a `$date`, canonical or relaxed. */
export function dateMillis(value: unknown): number {
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value === 'number') return value;
  if (isPlain(value)) return Number(value['$numberLong']);
  return Number.NaN;
}

export function isoDate(millis: number): string | undefined {
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** When an ObjectId was created, from its first four bytes. */
export function objectIdDate(hex: string): string | undefined {
  if (!/^[0-9a-f]{24}$/i.test(hex)) return undefined;
  return isoDate(parseInt(hex.slice(0, 8), 16) * 1000);
}

export function inner(value: Plain, key: string): Plain {
  const found = value[key];
  return isPlain(found) ? found : {};
}
