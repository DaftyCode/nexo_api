/**
 * BSON values as the backend sends them: canonical Extended JSON, so every type survives.
 * Here they are named, shown as the MongoDB shell writes them, converted to relaxed
 * Extended JSON, and laid out as table columns and tree rows.
 */

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

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
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

function binarySubtype(value: Plain): string {
  const binary = value['$binary'];
  return isPlain(binary) ? String(binary['subType'] ?? '00').padStart(2, '0') : '00';
}

function base64Bytes(text: string): number[] {
  try {
    return Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return [];
  }
}

/** A UUID's text from its binary value. */
function uuidText(base64: string): string {
  const hex = base64Bytes(base64)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds since 1970 of a `$date`, canonical or relaxed. */
function dateMillis(value: unknown): number {
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value === 'number') return value;
  if (isPlain(value)) return Number(value['$numberLong']);
  return Number.NaN;
}

function isoDate(millis: number): string | undefined {
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** When an ObjectId was created, from its first four bytes. */
export function objectIdDate(hex: string): string | undefined {
  if (!/^[0-9a-f]{24}$/i.test(hex)) return undefined;
  return isoDate(parseInt(hex.slice(0, 8), 16) * 1000);
}

function inner(value: Plain, key: string): Plain {
  const found = value[key];
  return isPlain(found) ? found : {};
}

/** A double as the shell writes it: always with a decimal point, so it reads back as one. */
function doubleText(text: string): string {
  if (/^-?\d+$/.test(text)) return `${text}.0`;
  if (text === 'Infinity' || text === '-Infinity' || text === 'NaN') return `Double('${text}')`;
  return text;
}

const quote = (text: string) => JSON.stringify(text);

/** A scalar value as the MongoDB shell writes it. Documents and arrays are written by `shell`. */
function scalarShell(value: unknown, type: BsonType): string {
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

/** The short text of a value in a table cell or a tree row. */
export function summary(value: unknown): string {
  const type = bsonType(value);
  if (type === 'Array') {
    const length = (value as unknown[]).length;
    return `[ ${length} ${length === 1 ? 'element' : 'elements'} ]`;
  }
  if (type === 'Document') {
    const length = Object.keys(value as Plain).length;
    return `{ ${length} ${length === 1 ? 'field' : 'fields'} }`;
  }
  const wrapped = isPlain(value) ? value : {};
  switch (type) {
    case 'String': {
      const text = String(value);
      return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    }
    case 'ObjectId':
      return String(wrapped['$oid']);
    case 'Int32':
    case 'Int64':
    case 'Double':
    case 'Decimal128':
      return typeof value === 'number' ? String(value) : String(Object.values(wrapped)[0]);
    case 'Date':
      return isoDate(dateMillis(wrapped['$date'])) ?? String(dateMillis(wrapped['$date']));
    case 'UUID':
      return uuidText(String(inner(wrapped, '$binary')['base64'] ?? ''));
    case 'Binary':
      return `Binary (${base64Bytes(String(inner(wrapped, '$binary')['base64'] ?? '')).length} bytes)`;
    default:
      return scalarShell(value, type);
  }
}

/** The value at a path of field names and array indexes; `undefined` when it is missing. */
export function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const step of path) {
    if (Array.isArray(current) && typeof step === 'number') current = current[step];
    else if (isPlain(current) && bsonType(current) === 'Document') current = current[step];
    else return undefined;
  }
  return current;
}

/** A column of the table: a field, or a field of an embedded document. */
export interface TableColumn {
  path: readonly string[];
  /** Dotted, as MongoDB names an embedded field. */
  label: string;
  /** Some rows have a document there, which can be shown as its own columns. */
  expandable: boolean;
}

/**
 * The columns of a page: every first-level field in the order they first appear (`_id`
 * first), with the embedded documents named in `expanded` (dotted paths) opened into
 * columns of their own fields.
 */
export function tableColumns(
  rows: readonly unknown[],
  expanded: ReadonlySet<string> = new Set(),
  prefix: readonly string[] = [],
): TableColumn[] {
  const names: string[] = [];
  const documents = new Set<string>();
  for (const row of rows) {
    if (bsonType(row) !== 'Document') continue;
    for (const [key, value] of Object.entries(row as Plain)) {
      if (!names.includes(key)) names.push(key);
      if (bsonType(value) === 'Document') documents.add(key);
    }
  }
  if (!prefix.length && names.includes('_id'))
    names.unshift(...names.splice(names.indexOf('_id'), 1));
  const columns: TableColumn[] = [];
  for (const name of names) {
    const path = [...prefix, name];
    const label = path.join('.');
    if (documents.has(name) && expanded.has(label)) {
      const children = rows.map((row) => valueAt(row, [name]));
      // The embedded documents' own fields, named by their full path.
      columns.push(...tableColumns(children, expanded, path));
      continue;
    }
    columns.push({ path, label, expandable: documents.has(name) });
  }
  return columns;
}

/** A visible row of the tree view. */
export interface TreeRow {
  /** Unique within the page: the document's position and the path in it. */
  id: string;
  document: number;
  path: readonly (string | number)[];
  depth: number;
  key: string;
  type: BsonType;
  text: string;
  expandable: boolean;
  expanded: boolean;
}

/** The rows of the tree view: each document, and the fields of the ones opened. */
export function treeRows(documents: readonly unknown[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (value: unknown, document: number, path: (string | number)[], key: string) => {
    const id = [document, ...path].join('/');
    const type = bsonType(value);
    const expandable = isContainer(value);
    const open = expandable && expanded.has(id);
    rows.push({
      id,
      document,
      path,
      depth: path.length,
      key,
      type,
      text: summary(value),
      expandable,
      expanded: open,
    });
    if (!open) return;
    if (Array.isArray(value))
      value.forEach((item, index) => visit(item, document, [...path, index], `[${index}]`));
    else
      for (const [field, item] of Object.entries(value as Plain))
        visit(item, document, [...path, field], field);
  };
  documents.forEach((document, index) => {
    const id = valueAt(document, ['_id']);
    visit(
      document,
      index,
      [],
      id === undefined ? `(${index + 1})` : `(${index + 1}) ${summary(id)}`,
    );
  });
  return rows;
}
