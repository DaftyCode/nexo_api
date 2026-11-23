/**
 * The documents of MongoDB in the data grid of the databases (DB-41): one column per field
 * (embedded documents opened into columns), each value as the grid draws it, with its BSON
 * type kept in the column's type and in how the cell is aligned and written.
 */
import { BsonType, TableColumn, bsonType, summary, valueAt } from '../bson';
import type { ResultColumn } from '../db/results';

/** The grid's kind of value of a BSON type: numbers to the right, dates by the formats. */
function kindOf(type: BsonType): string {
  switch (type) {
    case 'Int32':
    case 'Int64':
      return 'integer';
    case 'Double':
    case 'Decimal128':
      return 'decimal';
    case 'Date':
      return 'timestamp';
    case 'Boolean':
      return 'boolean';
    case 'Document':
    case 'Array':
      return 'json';
    default:
      return 'text';
  }
}

/**
 * A value as the grid draws it: a missing field blank, `null` as the grid writes it, booleans
 * as they are, and the rest by the grid's kind with the text the tree and the table show
 * (`{ 2 fields }`, `[ 3 elements ]`, an ObjectId's hexadecimal, a date in ISO 8601).
 */
export function gridValue(value: unknown): unknown {
  if (value === undefined) return { $t: 'text', v: '' };
  const type = bsonType(value);
  if (type === 'Null') return null;
  if (type === 'Boolean') return value;
  if (type === 'String') return value;
  const kind = kindOf(type);
  // A document or an array opens or is entered; its summary is what the cell says.
  return { $t: kind === 'json' ? 'text' : kind, v: summary(value) };
}

/** The types a column holds in these rows, the most frequent first, as its type's name. */
function typesOf(rows: readonly unknown[], column: TableColumn): BsonType[] {
  const counts = new Map<BsonType, number>();
  for (const row of rows) {
    const value = valueAt(row, column.path);
    if (value === undefined) continue;
    const type = bsonType(value);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
}

/** The grid's columns: each field's label (`Value` for elements that are not documents). */
export function gridColumns(
  rows: readonly unknown[],
  columns: readonly TableColumn[],
  valueLabel: string,
): ResultColumn[] {
  return columns.map((column) => {
    const types = typesOf(rows, column);
    return {
      name: column.label || valueLabel,
      typeName: types.slice(0, 3).join(' | ') + (types.length > 3 ? ' | …' : ''),
      kind: types.length === 1 ? kindOf(types[0]) : 'text',
      ...(column.label === '_id' ? { key: true } : {}),
    };
  });
}

/** The grid's rows: each row's value of each column. */
export function gridRows(rows: readonly unknown[], columns: readonly TableColumn[]): unknown[][] {
  return rows.map((row) => columns.map((column) => gridValue(valueAt(row, column.path))));
}
