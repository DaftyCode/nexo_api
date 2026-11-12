/** Shell constructors and literals (ObjectId, ISODate, NumberLong…) as Extended JSON. */

import { INT32, type Json, REGEX_OPTIONS } from './reader';

export function regex(pattern: string, options: string): Json {
  return { $regularExpression: { pattern, options: [...options].sort().join('') } };
}

/** A number literal: integers as they are (64-bit when they need it), decimals as doubles. */
export function numberLiteral(text: string): Json {
  const negative = text.startsWith('-');
  const body = text.replace(/^[-+]/, '');
  if (body === 'Infinity') return { $numberDouble: negative ? '-Infinity' : 'Infinity' };
  if (/^0[xX]/.test(body)) return (negative ? -1 : 1) * parseInt(body, 16);
  if (/^\d+$/.test(body)) {
    const integer = BigInt(body) * (negative ? -1n : 1n);
    if (integer >= -(2n ** 63n) && integer < 2n ** 63n) {
      const value = Number(integer);
      return Number.isSafeInteger(value) ? value : { $numberLong: integer.toString() };
    }
  }
  const value = Number(text);
  // A double written as `2.0` stays a double.
  return Number.isInteger(value) ? { $numberDouble: doubleString(value) } : value;
}

/** A double's text in Extended JSON: `2.0`, not `2`, as the server writes it. */
function doubleString(value: number): string {
  const text = String(value);
  return Number.isInteger(value) && !/e/i.test(text) ? `${text}.0` : text;
}

function text(value: Json | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = Object.values(value)[0];
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

function integerText(value: Json | undefined): string {
  const found = text(value);
  if (found === undefined || !/^[-+]?\d+$/.test(found.trim()))
    throw new Error('This function needs an integer');
  return BigInt(found.trim()).toString();
}

function base64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function hexBytes(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
}

/** A new ObjectId: the time, then random bytes. */
function newObjectId(): string {
  const seconds = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return seconds + random;
}

function date(args: Json[]): Json {
  if (!args.length) return { $date: { $numberLong: String(Date.now()) } };
  const value = args[0];
  const millis =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(millis)) throw new Error('Invalid date');
  return { $date: { $numberLong: String(Math.trunc(millis)) } };
}

/** The shell's type constructors, as Extended JSON. */
export function construct(name: string, args: Json[]): Json {
  const [first, second] = args;
  switch (name) {
    case 'ObjectId': {
      if (!args.length) return { $oid: newObjectId() };
      const hex = text(first) ?? '';
      if (!/^[0-9a-fA-F]{24}$/.test(hex)) throw new Error('An ObjectId has 24 hexadecimal digits');
      return { $oid: hex.toLowerCase() };
    }
    case 'ISODate':
    case 'Date':
      return date(args);
    case 'NumberInt':
    case 'Int32': {
      const value = Number(integerText(first ?? 0));
      if (value < -INT32 || value >= INT32) throw new Error('The number does not fit in 32 bits');
      return { $numberInt: String(value) };
    }
    case 'NumberLong':
    case 'Long': {
      const value = BigInt(integerText(first ?? 0));
      if (value < -(2n ** 63n) || value >= 2n ** 63n)
        throw new Error('The number does not fit in 64 bits');
      return { $numberLong: value.toString() };
    }
    case 'Double': {
      const value = text(first) ?? '0';
      if (Number.isNaN(Number(value)) && value !== 'NaN') throw new Error('Invalid number');
      return { $numberDouble: doubleString(Number(value)) };
    }
    case 'NumberDecimal':
    case 'Decimal128': {
      const value = text(first) ?? '0';
      if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^[-+]?(Infinity|Inf|NaN)$/i.test(value))
        throw new Error('Invalid decimal number');
      return { $numberDecimal: value };
    }
    case 'Timestamp': {
      const parts =
        first && typeof first === 'object' && !Array.isArray(first)
          ? [first['t'], first['i']]
          : [first, second];
      const [t, i] = parts.map((part) => Number(integerText(part ?? 0)));
      return { $timestamp: { t, i } };
    }
    case 'BinData': {
      const subtype = Number(integerText(first ?? 0));
      const data = text(second) ?? '';
      if (subtype < 0 || subtype > 255) throw new Error('A binary subtype is between 0 and 255');
      try {
        atob(data);
      } catch {
        throw new Error('Invalid base64');
      }
      return { $binary: { base64: data, subType: subtype.toString(16).padStart(2, '0') } };
    }
    case 'HexData': {
      const subtype = Number(integerText(first ?? 0));
      const hex = text(second) ?? '';
      if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('Invalid hexadecimal data');
      return {
        $binary: { base64: base64(hexBytes(hex)), subType: subtype.toString(16).padStart(2, '0') },
      };
    }
    case 'UUID': {
      const hex = (text(first) ?? '').replace(/-/g, '');
      if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('A UUID has 32 hexadecimal digits');
      return { $binary: { base64: base64(hexBytes(hex)), subType: '04' } };
    }
    case 'MinKey':
      return { $minKey: 1 };
    case 'MaxKey':
      return { $maxKey: 1 };
    case 'RegExp': {
      const pattern = text(first) ?? '';
      const options = text(second) ?? '';
      if (!REGEX_OPTIONS.test(options)) throw new Error('Unknown regular expression option');
      return regex(pattern, options);
    }
    case 'DBRef': {
      const ref: Record<string, Json> = { $ref: text(first) ?? '', $id: second ?? null };
      if (args[2] !== undefined) ref['$db'] = args[2];
      return ref;
    }
    default:
      throw new Error('Unknown function');
  }
}
