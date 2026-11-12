/**
 * BSON values written in the syntax of each driver: the canonical Extended JSON of a query
 * becomes `new ObjectId("…")`, `ObjectId("…")`, `ObjectId.Parse("…")`… with the types each
 * language needs. Every writer notes the names it uses, for the program's imports.
 */
import { binarySubtype, bsonType, dateMillis, inner, isPlain, isoDate, uuidText } from '../bson';

export type CodeLanguage =
  'mongosh' | 'node' | 'python' | 'java' | 'csharp' | 'go' | 'rust' | 'php' | 'ruby';

/** A value that a driver cannot write. */
export class CodegenError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(key);
  }
}

/** A scalar BSON value, read from its Extended JSON. */
export type Scalar =
  | { type: 'String' | 'Code' | 'Symbol'; text: string }
  | { type: 'Int32' | 'Int64' | 'Double' | 'Decimal128'; text: string }
  | { type: 'Boolean'; value: boolean }
  | { type: 'Null' | 'MinKey' | 'MaxKey' }
  | { type: 'Date'; millis: number; iso: string }
  | { type: 'ObjectId'; hex: string }
  | { type: 'Binary'; base64: string; subtype: number }
  | { type: 'UUID'; uuid: string; base64: string }
  | { type: 'RegExp'; pattern: string; options: string }
  | { type: 'Timestamp'; t: number; i: number };

/** A double as source code: always with a decimal point or exponent. */
function doubleText(number: number): string {
  const text = String(number);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

export function scalar(value: unknown): Scalar {
  const type = bsonType(value);
  const wrapped = isPlain(value) ? value : {};
  switch (type) {
    case 'String':
      return { type, text: String(value) };
    case 'Code':
      return { type, text: String(wrapped['$code']) };
    case 'Symbol':
      return { type, text: String(wrapped['$symbol']) };
    case 'Int32':
      return {
        type,
        text: typeof value === 'number' ? String(value) : String(wrapped['$numberInt']),
      };
    case 'Int64':
      return {
        type,
        text: typeof value === 'number' ? String(value) : String(wrapped['$numberLong']),
      };
    case 'Double': {
      const number = typeof value === 'number' ? value : Number(wrapped['$numberDouble']);
      if (!Number.isFinite(number))
        throw new CodegenError('mongo.code.unsupported', { v0: String(number) });
      return { type, text: doubleText(number) };
    }
    case 'Decimal128':
      return { type, text: String(wrapped['$numberDecimal']) };
    case 'Boolean':
      return { type, value: value === true };
    case 'Null':
    case 'Undefined':
      return { type: 'Null' };
    case 'MinKey':
    case 'MaxKey':
      return { type };
    case 'Date': {
      const millis = dateMillis(wrapped['$date']);
      return { type, millis, iso: isoDate(millis) ?? new Date(millis).toISOString() };
    }
    case 'ObjectId':
      return { type, hex: String(wrapped['$oid']) };
    case 'Binary': {
      const binary = inner(wrapped, '$binary');
      return {
        type,
        base64: String(binary['base64'] ?? ''),
        subtype: parseInt(binarySubtype(wrapped), 16),
      };
    }
    case 'UUID': {
      const base64 = String(inner(wrapped, '$binary')['base64'] ?? '');
      return { type, uuid: uuidText(base64), base64 };
    }
    case 'RegExp': {
      const regex = inner(wrapped, '$regularExpression');
      return {
        type,
        pattern: String(regex['pattern'] ?? ''),
        options: String(regex['options'] ?? ''),
      };
    }
    case 'Timestamp': {
      const stamp = inner(wrapped, '$timestamp');
      return { type, t: Number(stamp['t']), i: Number(stamp['i']) };
    }
    default:
      throw new CodegenError('mongo.code.unsupported', { v0: type });
  }
}

/** A string literal of the language, with its escapes. */
export function quote(language: CodeLanguage, text: string): string {
  if (language === 'php' || language === 'ruby')
    return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const json = JSON.stringify(text);
  return language === 'rust' ? json.replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}') : json;
}

/** The parts of a value: a document's entries, an array's items, or a scalar. */
export type Shape =
  | { kind: 'document'; entries: [string, unknown][] }
  | { kind: 'array'; items: unknown[] }
  | { kind: 'scalar'; scalar: Scalar };

export function shape(value: unknown): Shape {
  const type = bsonType(value);
  if (type === 'Array') return { kind: 'array', items: value as unknown[] };
  if (type === 'Document') return { kind: 'document', entries: Object.entries(value as object) };
  return { kind: 'scalar', scalar: scalar(value) };
}

/** Writes values of one language and remembers what they used. */
export interface ValueWriter {
  readonly uses: Set<string>;
  value(value: unknown, indent: number): string;
}

/** Indentation of the given depth. */
export const pad = (indent: number, unit = '  ') => unit.repeat(indent);
