/**
 * MongoDB queries as people type them: in Extended JSON (canonical or relaxed) or in the
 * shell's syntax (`{status: 'A', _id: ObjectId("…"), at: {$gte: ISODate("…")}}`). The shell
 * syntax is read here and turned into Extended JSON before anything is sent. No JavaScript
 * is evaluated: only literals and the shell's type constructors are understood.
 */

/** A database of a deployment, as the explorer lists it. */
export interface DatabaseSummary {
  name: string;
  sizeOnDisk?: number;
  empty: boolean;
}

/** A collection, view or time series collection. */
export interface CollectionSummary {
  name: string;
  kind: 'collection' | 'view' | 'timeseries';
  /** The GridFS bucket it belongs to. */
  gridfs?: string;
  viewOn?: string;
  capped: boolean;
}

export interface IndexSummary {
  name: string;
  /** In canonical Extended JSON. */
  keys: Record<string, unknown>;
  unique: boolean;
}

export interface CollectionStats {
  count: number;
  size: number;
  storageSize: number;
  averageDocumentSize?: number;
  totalIndexSize: number;
  indexes: IndexSummary[];
  capped: boolean;
}

/** A page of results, each document in canonical Extended JSON. */
export interface DocumentPage {
  documents: Record<string, unknown>[];
  /** Reads the next page while the server keeps the cursor open. */
  cursor?: string;
  /** Stopped early at the size the interface receives at once. */
  truncated: boolean;
  elapsedMs: number;
}

/** Why a query field cannot be read, with where. `reason` is a message key. */
export class QuerySyntaxError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
    readonly column: number,
    readonly detail = '',
  ) {
    super(`${reason}${detail ? ` (${detail})` : ''} at line ${line}, column ${column}`);
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const IDENTIFIER = /[A-Za-z0-9_$.]/;
const INT32 = 2 ** 31;
const REGEX_OPTIONS = /^[imsxu]*$/;

class Reader {
  private index = 0;
  constructor(private readonly text: string) {}

  fail(reason: string, detail = '', at = this.index): never {
    const before = this.text.slice(0, at).split('\n');
    throw new QuerySyntaxError(reason, before.length, before[before.length - 1].length + 1, detail);
  }

  /** Skips spaces and comments. */
  private space() {
    for (;;) {
      while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index++;
      if (this.text.startsWith('//', this.index)) {
        const end = this.text.indexOf('\n', this.index);
        this.index = end < 0 ? this.text.length : end;
      } else if (this.text.startsWith('/*', this.index)) {
        const end = this.text.indexOf('*/', this.index + 2);
        if (end < 0) this.fail('Unclosed comment');
        this.index = end + 2;
      } else return;
    }
  }

  private peek() {
    this.space();
    return this.text[this.index] ?? '';
  }

  private expect(char: string) {
    if (this.peek() !== char)
      this.fail(
        this.index < this.text.length ? 'Unexpected character' : 'The text ends too soon',
        `expected ${char}`,
      );
    this.index++;
  }

  /** The whole text as one value. */
  document(): Json {
    const value = this.value();
    if (this.peek()) this.fail('Unexpected character', this.text[this.index]);
    return value;
  }

  private value(): Json {
    const char = this.peek();
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"' || char === "'") return this.string();
    if (char === '/') return this.regex();
    if (/[-+\d.]/.test(char)) return this.number();
    if (/[A-Za-z_$]/.test(char)) return this.word();
    if (!char) this.fail('The text ends too soon', 'expected a value');
    return this.fail('Unexpected character', char);
  }

  private object(): Json {
    this.expect('{');
    const object: Record<string, Json> = {};
    while (this.peek() !== '}') {
      const char = this.peek();
      let key: string;
      if (char === '"' || char === "'") key = this.string();
      else if (IDENTIFIER.test(char)) key = this.identifier();
      else
        return this.fail(
          char ? 'Unexpected character' : 'The text ends too soon',
          char ? char : 'expected }',
        );
      this.expect(':');
      object[key] = this.value();
      this.separator('}');
    }
    this.index++;
    return object;
  }

  private array(): Json[] {
    this.expect('[');
    const items: Json[] = [];
    while (this.peek() !== ']') {
      if (!this.peek()) this.fail('The text ends too soon', 'expected ]');
      items.push(this.value());
      this.separator(']');
    }
    this.index++;
    return items;
  }

  /** After an item: a comma, or the end of the list. */
  private separator(close: string) {
    const char = this.peek();
    if (char === ',') this.index++;
    else if (char !== close)
      this.fail(char ? 'Unexpected character' : 'The text ends too soon', `expected , or ${close}`);
  }

  private identifier(): string {
    this.space();
    const start = this.index;
    while (this.index < this.text.length && IDENTIFIER.test(this.text[this.index])) this.index++;
    return this.text.slice(start, this.index);
  }

  private string(): string {
    const quote = this.peek();
    const start = this.index++;
    let out = '';
    for (;;) {
      const char = this.text[this.index++];
      if (char === undefined || char === '\n') this.fail('Unclosed string', '', start);
      if (char === quote) return out;
      if (char !== '\\') {
        out += char;
        continue;
      }
      const escaped = this.text[this.index++];
      const simple: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        v: '\v',
        '0': '\0',
      };
      if (escaped === 'u' || escaped === 'x') {
        const length = escaped === 'u' ? 4 : 2;
        const hex = this.text.slice(this.index, this.index + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex))
          this.fail('Invalid escape in a string');
        out += String.fromCharCode(parseInt(hex, 16));
        this.index += length;
      } else out += simple[escaped] ?? escaped;
    }
  }

  private regex(): Json {
    const start = this.index++;
    let pattern = '';
    let inClass = false;
    for (;;) {
      const char = this.text[this.index++];
      if (char === undefined || char === '\n') this.fail('Unclosed regular expression', '', start);
      if (char === '\\') {
        pattern += char + (this.text[this.index++] ?? '');
        continue;
      }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
      pattern += char;
    }
    const flagsAt = this.index;
    const options = this.identifier();
    if (!REGEX_OPTIONS.test(options))
      this.fail('Unknown regular expression option', options, flagsAt);
    return regex(pattern.replace(/\\\//g, '/'), options);
  }

  private number(): Json {
    const start = this.index;
    const match = /^[-+]?(?:Infinity|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(
      this.text.slice(this.index),
    );
    if (!match) return this.fail('Invalid number', '', start);
    this.index += match[0].length;
    return numberLiteral(match[0]);
  }

  private word(): Json {
    const start = this.index;
    let name = this.identifier();
    if (name === 'new') name = this.identifier();
    switch (name) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'undefined':
        return { $undefined: true };
      case 'Infinity':
      case 'NaN':
        return { $numberDouble: name };
    }
    if (this.peek() !== '(') this.fail('Unknown name', name, start);
    this.index++;
    const args: Json[] = [];
    while (this.peek() !== ')') {
      if (!this.peek()) this.fail('The text ends too soon', 'expected )');
      args.push(this.value());
      this.separator(')');
    }
    this.index++;
    try {
      return construct(name, args);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error), name, start);
    }
  }
}

function regex(pattern: string, options: string): Json {
  return { $regularExpression: { pattern, options: [...options].sort().join('') } };
}

/** A number literal: integers as they are (64-bit when they need it), decimals as doubles. */
function numberLiteral(text: string): Json {
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
function construct(name: string, args: Json[]): Json {
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

/** A query field in shell syntax or Extended JSON, as Extended JSON. */
export function shellToExtendedJson(source: string): Json {
  return new Reader(source).document();
}

/** The fields of the query bar, as typed. */
export interface QueryForm {
  filter: string;
  projection: string;
  sort: string;
  collation: string;
  /** An index name, or its keys as a document. */
  hint: string;
  skip: string;
  limit: string;
}

export function emptyQueryForm(): QueryForm {
  return { filter: '', projection: '', sort: '', collation: '', hint: '', skip: '', limit: '' };
}

/** A query ready to send. */
export interface BuiltQuery {
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  collation?: Record<string, unknown>;
  hint?: string | Record<string, unknown>;
  skip?: number;
  limit?: number;
}

/** A field that cannot be used, with the message key and its values. */
export class QueryFieldError extends Error {
  constructor(
    readonly field: keyof QueryForm,
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(`${field}: ${key}`);
  }
}

const VARIABLE = /\{\{\s*([^{}]+?)\s*\}\}/;

function documentField(
  field: keyof QueryForm,
  source: string,
): Record<string, unknown> | undefined {
  if (!source.trim()) return undefined;
  const variable = VARIABLE.exec(source);
  if (variable) throw new QueryFieldError(field, 'mongo.undefinedVariable', { v0: variable[1] });
  let value: Json;
  try {
    value = shellToExtendedJson(source);
  } catch (error) {
    if (!(error instanceof QuerySyntaxError)) throw error;
    throw new QueryFieldError(field, 'mongo.syntax', {
      v0: error.reason,
      v1: error.line,
      v2: error.column,
      v3: error.detail,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new QueryFieldError(field, 'mongo.notDocument');
  return value as Record<string, unknown>;
}

function countField(field: 'skip' | 'limit', source: string): number | undefined {
  const text = source.trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new QueryFieldError(field, 'mongo.notCount');
  return Number(text) || undefined;
}

/**
 * The query to send. `resolve` replaces the variables of the active environment; one left
 * undefined is named.
 */
export function buildQuery(
  form: QueryForm,
  resolve: (text: string) => string = (t) => t,
): BuiltQuery {
  const query: BuiltQuery = {};
  const filter = documentField('filter', resolve(form.filter));
  const projection = documentField('projection', resolve(form.projection));
  const sort = documentField('sort', resolve(form.sort));
  const collation = documentField('collation', resolve(form.collation));
  if (filter) query.filter = filter;
  if (projection) query.projection = projection;
  if (sort) query.sort = sort;
  if (collation) query.collation = collation;
  const hint = resolve(form.hint).trim();
  if (hint.startsWith('{')) query.hint = documentField('hint', hint);
  else if (hint) query.hint = hint.replace(/^(['"])(.*)\1$/, '$2');
  const skip = countField('skip', form.skip);
  const limit = countField('limit', form.limit);
  if (skip) query.skip = skip;
  if (limit) query.limit = limit;
  return query;
}

/** A saved query, or one of the history: where it runs and what it asks. */
export interface MongoQueryValue extends QueryForm {
  /** The id of its connection document. */
  connection: string;
  database: string;
  collection: string;
  folder?: string;
}

/** Reads a stored query defensively. */
export function queryValue(value: unknown): MongoQueryValue {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const read = (key: string) => (typeof stored[key] === 'string' ? (stored[key] as string) : '');
  const query: MongoQueryValue = {
    ...emptyQueryForm(),
    connection: read('connection'),
    database: read('database'),
    collection: read('collection'),
  };
  for (const key of Object.keys(emptyQueryForm()) as (keyof QueryForm)[]) query[key] = read(key);
  if (read('folder')) query.folder = read('folder');
  return query;
}

/** One line that names a query: where it runs and its filter. */
export function querySummary(
  query: Pick<MongoQueryValue, 'database' | 'collection'> & Partial<QueryForm>,
): string {
  const filter = (query.filter ?? '').replace(/\s+/g, ' ').trim();
  const line = `${query.database}.${query.collection}${filter ? ` ${filter}` : ''}`;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
