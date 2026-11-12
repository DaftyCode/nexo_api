/** Documents shown as a summary, a table or a tree. */

import {
  base64Bytes,
  bsonType,
  type BsonType,
  dateMillis,
  inner,
  isContainer,
  isoDate,
  isPlain,
  type Plain,
  uuidText,
} from '../bson';
import { scalarShell } from './shell';

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
