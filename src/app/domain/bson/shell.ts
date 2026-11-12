/** Extended JSON values written as the mongo shell writes them, or as relaxed JSON. */

import {
  binarySubtype,
  bsonType,
  type BsonType,
  dateMillis,
  inner,
  isoDate,
  isPlain,
  type Plain,
  uuidText,
} from '../bson';

/** A double as the shell writes it: always with a decimal point, so it reads back as one. */
function doubleText(text: string): string {
  if (/^-?\d+$/.test(text)) return `${text}.0`;
  if (text === 'Infinity' || text === '-Infinity' || text === 'NaN') return `Double('${text}')`;
  return text;
}

const quote = (text: string) => JSON.stringify(text);

/** A scalar value as the MongoDB shell writes it. Documents and arrays are written by `shell`. */
export function scalarShell(value: unknown, type: BsonType): string {
  const wrapped = isPlain(value) ? value : {};
  switch (type) {
    case 'ObjectId':
      return `ObjectId(${quote(String(wrapped['$oid']))})`;
    case 'Int32':
      return `NumberInt(${typeof value === 'number' ? value : String(wrapped['$numberInt'])})`;
    case 'Int64':
      return `NumberLong(${quote(String(wrapped['$numberLong']))})`;
    case 'Double':
      return typeof value === 'number'
        ? String(value)
        : doubleText(String(wrapped['$numberDouble']));
    case 'Decimal128':
      return `NumberDecimal(${quote(String(wrapped['$numberDecimal']))})`;
    case 'Date': {
      const raw = wrapped['$date'];
      const iso = isoDate(dateMillis(raw));
      // Out of JavaScript's range: the exact milliseconds the server sent.
      return iso
        ? `ISODate(${quote(iso)})`
        : `new Date(${isPlain(raw) ? String(raw['$numberLong']) : String(raw)})`;
    }
    case 'Binary': {
      const binary = inner(wrapped, '$binary');
      return `BinData(${parseInt(binarySubtype(wrapped), 16)}, ${quote(String(binary['base64'] ?? ''))})`;
    }
    case 'UUID':
      return `UUID(${quote(uuidText(String(inner(wrapped, '$binary')['base64'] ?? '')))})`;
    case 'RegExp': {
      const regex = inner(wrapped, '$regularExpression');
      const pattern = String(regex['pattern'] ?? '').replace(/\//g, '\\/');
      return `/${pattern}/${String(regex['options'] ?? '')}`;
    }
    case 'Timestamp': {
      const stamp = inner(wrapped, '$timestamp');
      return `Timestamp({ t: ${Number(stamp['t'])}, i: ${Number(stamp['i'])} })`;
    }
    case 'MinKey':
      return 'MinKey()';
    case 'MaxKey':
      return 'MaxKey()';
    case 'Code':
      return `Code(${quote(String(wrapped['$code']))})`;
    case 'Symbol':
      return `Symbol(${quote(String(wrapped['$symbol']))})`;
    case 'DBPointer': {
      const pointer = inner(wrapped, '$dbPointer');
      return `DBPointer(${quote(String(pointer['$ref']))}, ${scalarShell(pointer['$id'], 'ObjectId')})`;
    }
    case 'Undefined':
      return 'undefined';
    case 'String':
      return quote(String(value));
    default:
      return JSON.stringify(value);
  }
}

/** A value as the MongoDB shell writes it, indented with two spaces. */
export function shell(value: unknown, indent = 0): string {
  const type = bsonType(value);
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (type === 'Array') {
    const items = value as unknown[];
    if (!items.length) return '[]';
    return `[\n${items.map((item) => pad + shell(item, indent + 1)).join(',\n')}\n${end}]`;
  }
  if (type === 'Document') {
    const entries = Object.entries(value as Plain);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([key, item]) => `${pad}${quote(key)}: ${shell(item, indent + 1)}`).join(',\n')}\n${end}}`;
  }
  return scalarShell(value, type);
}

/** Relaxed Extended JSON: numbers and dates written plainly where nothing is lost. */
export function relaxed(value: unknown): unknown {
  const type = bsonType(value);
  if (type === 'Array') return (value as unknown[]).map(relaxed);
  if (type === 'Document')
    return Object.fromEntries(Object.entries(value as Plain).map(([k, v]) => [k, relaxed(v)]));
  if (!isPlain(value)) return value;
  switch (type) {
    case 'Int32':
      return Number(value['$numberInt']);
    case 'Double': {
      const number = Number(value['$numberDouble']);
      return Number.isFinite(number) ? number : value;
    }
    case 'Int64': {
      const number = Number(value['$numberLong']);
      return Number.isSafeInteger(number) ? number : value;
    }
    case 'Date': {
      const millis = dateMillis(value['$date']);
      const year = new Date(millis).getUTCFullYear();
      const iso = isoDate(millis);
      return iso && year >= 1970 && year <= 9999 ? { $date: iso } : value;
    }
    default:
      return value;
  }
}
