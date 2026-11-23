import { describe, expect, it } from 'vitest';
import { tableColumns } from '../bson';
import { gridColumns, gridRows, gridValue } from './grid';

describe('MongoDB documents in the data grid', () => {
  it('draws each value by its BSON type', () => {
    expect(gridValue(undefined)).toEqual({ $t: 'text', v: '' });
    expect(gridValue(null)).toBeNull();
    expect(gridValue(true)).toBe(true);
    expect(gridValue('Ana')).toBe('Ana');
    expect(gridValue({ $numberInt: '7' })).toEqual({ $t: 'integer', v: '7' });
    expect(gridValue({ $numberDecimal: '1.10' })).toEqual({ $t: 'decimal', v: '1.10' });
    expect(gridValue({ $date: { $numberLong: '1704164645006' } })).toEqual({
      $t: 'timestamp',
      v: '2024-01-02T03:04:05.006Z',
    });
    expect(gridValue({ $oid: '65a1b2c3d4e5f6a7b8c9d0e1' })).toEqual({
      $t: 'text',
      v: '65a1b2c3d4e5f6a7b8c9d0e1',
    });
    expect(gridValue({ a: 1, b: 2 })).toEqual({ $t: 'text', v: '{ 2 fields }' });
    expect(gridValue([1])).toEqual({ $t: 'text', v: '[ 1 element ]' });
  });

  it('names each column with the types it holds, and keeps the key', () => {
    const rows = [
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, n: { $numberInt: '1' }, mixed: 'a', at: null },
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e2' }, n: { $numberInt: '2' }, mixed: true },
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e3' }, mixed: { $numberInt: '3' } },
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e4' }, mixed: [1] },
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e5' }, mixed: 'b' },
    ];
    const columns = tableColumns(rows, new Set());
    const grid = gridColumns(rows, columns, 'Value');
    expect(grid.map((column) => [column.name, column.typeName, column.kind, !!column.key])).toEqual(
      [
        ['_id', 'ObjectId', 'text', true],
        ['n', 'Int32', 'integer', false],
        ['mixed', 'String | Boolean | Int32 | …', 'text', false],
        ['at', 'Null', 'text', false],
      ],
    );
    // Elements that are not documents are one column with no field name.
    expect(gridColumns([1, 2], [{ path: [], label: '', expandable: false }], 'Value')[0].name).toBe(
      'Value',
    );
    const values = gridRows(rows, columns);
    expect(values[2]).toEqual([
      { $t: 'text', v: '65a1b2c3d4e5f6a7b8c9d0e3' },
      { $t: 'text', v: '' },
      { $t: 'integer', v: '3' },
      { $t: 'text', v: '' },
    ]);
  });
});
