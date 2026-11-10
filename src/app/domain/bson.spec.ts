import {
  bsonType,
  objectIdDate,
  relaxed,
  shell,
  summary,
  tableColumns,
  treeRows,
  valueAt,
} from './bson';
import { shellToExtendedJson } from './mongo-query';

/** One document with a value of each type, as the backend sends it. */
const types = {
  _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
  int: { $numberInt: '7' },
  long: { $numberLong: '9007199254740993' },
  double: { $numberDouble: '2.0' },
  decimal: { $numberDecimal: '1.10' },
  date: { $date: { $numberLong: '1704164645006' } },
  binary: { $binary: { base64: 'AQID', subType: '00' } },
  uuid: { $binary: { base64: 'OyQRAeK7QlWMr0E2xWapYg==', subType: '04' } },
  regex: { $regularExpression: { pattern: '^a/b', options: 'i' } },
  timestamp: { $timestamp: { t: 1700000000, i: 1 } },
  min: { $minKey: 1 },
  max: { $maxKey: 1 },
  nothing: null,
  yes: true,
  text: 'hé "quoted"',
  nested: { list: [{ $numberInt: '1' }, 'x'] },
};

describe('BSON values', () => {
  it('names every type', () => {
    expect(Object.fromEntries(Object.entries(types).map(([k, v]) => [k, bsonType(v)]))).toEqual({
      _id: 'ObjectId',
      int: 'Int32',
      long: 'Int64',
      double: 'Double',
      decimal: 'Decimal128',
      date: 'Date',
      binary: 'Binary',
      uuid: 'UUID',
      regex: 'RegExp',
      timestamp: 'Timestamp',
      min: 'MinKey',
      max: 'MaxKey',
      nothing: 'Null',
      yes: 'Boolean',
      text: 'String',
      nested: 'Document',
    });
    expect(bsonType([])).toBe('Array');
    expect(bsonType(1.5)).toBe('Double');
    expect(bsonType({ $code: 'x', scope: {} })).toBe('Code');
    expect(bsonType({ $symbol: 's' })).toBe('Symbol');
    expect(bsonType({ $gt: 1, $lt: 2 })).toBe('Document');
  });

  it('writes the shell syntax, which reads back to the same types', () => {
    const text = shell(types);
    expect(text).toContain('"_id": ObjectId("65a1b2c3d4e5f6a7b8c9d0e1")');
    expect(text).toContain('"long": NumberLong("9007199254740993")');
    expect(text).toContain('"double": 2.0');
    expect(text).toContain('"date": ISODate("2024-01-02T03:04:05.006Z")');
    expect(text).toContain('"uuid": UUID("3b241101-e2bb-4255-8caf-4136c566a962")');
    expect(text).toContain('"regex": /^a\\/b/i');
    expect(text).toContain('"timestamp": Timestamp({ t: 1700000000, i: 1 })');
    expect(shellToExtendedJson(text)).toEqual(types);
    expect(shell({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}');
    expect(shell({ $numberDouble: 'NaN' })).toBe("Double('NaN')");
    expect(shell({ $date: { $numberLong: '99999999999999999' } })).toBe(
      'new Date(99999999999999999)',
    );
  });

  it('converts to relaxed Extended JSON where nothing is lost', () => {
    expect(relaxed(types)).toMatchObject({
      int: 7,
      long: { $numberLong: '9007199254740993' },
      double: 2,
      date: { $date: '2024-01-02T03:04:05.006Z' },
      decimal: { $numberDecimal: '1.10' },
      nested: { list: [1, 'x'] },
    });
    expect(relaxed({ $date: { $numberLong: '-1000' } })).toEqual({
      $date: { $numberLong: '-1000' },
    });
    expect(relaxed({ $numberDouble: 'Infinity' })).toEqual({ $numberDouble: 'Infinity' });
  });

  it('summarizes values for cells and knows when an ObjectId was made', () => {
    expect(summary(types._id)).toBe('65a1b2c3d4e5f6a7b8c9d0e1');
    expect(summary(types.date)).toBe('2024-01-02T03:04:05.006Z');
    expect(summary(types.long)).toBe('9007199254740993');
    expect(summary(types.binary)).toBe('Binary (3 bytes)');
    expect(summary(types.uuid)).toBe('3b241101-e2bb-4255-8caf-4136c566a962');
    expect(summary(types.nested)).toBe('{ 1 field }');
    expect(summary(types.nested.list)).toBe('[ 2 elements ]');
    expect(summary('x'.repeat(300))).toHaveLength(201);
    expect(summary(types.min)).toBe('MinKey()');
    expect(objectIdDate('65a1b2c3d4e5f6a7b8c9d0e1')).toBe('2024-01-12T21:44:35.000Z');
    expect(objectIdDate('nope')).toBeUndefined();
  });

  it('lays documents out as columns, opening embedded documents', () => {
    const rows = [
      { n: 1, _id: 1, customer: { name: 'A', address: { city: 'Madrid' } } },
      { _id: 2, extra: true, customer: 'not a document' },
    ];
    expect(tableColumns(rows).map((c) => [c.label, c.expandable])).toEqual([
      ['_id', false],
      ['n', false],
      ['customer', true],
      ['extra', false],
    ]);
    const open = tableColumns(rows, new Set(['customer', 'customer.address']));
    expect(open.map((c) => c.label)).toEqual([
      '_id',
      'n',
      'customer.name',
      'customer.address.city',
      'extra',
    ]);
    expect(valueAt(rows[0], open[3].path)).toBe('Madrid');
    expect(valueAt(rows[1], open[3].path)).toBeUndefined();
    expect(valueAt({ a: [{ b: 1 }] }, ['a', 0, 'b'])).toBe(1);
    expect(valueAt(types, ['_id', '$oid'])).toBeUndefined();
  });

  it('lists the rows of the tree, opening what is expanded', () => {
    const documents = [
      { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, list: [1, { a: 2 }] },
      { x: 1 },
    ];
    expect(treeRows(documents, new Set()).map((r) => [r.key, r.text])).toEqual([
      ['(1) 65a1b2c3d4e5f6a7b8c9d0e1', '{ 2 fields }'],
      ['(2)', '{ 1 field }'],
    ]);
    const rows = treeRows(documents, new Set(['0', '0/list', '0/list/1']));
    expect(rows.map((r) => [r.id, r.depth, r.key, r.type, r.expanded])).toEqual([
      ['0', 0, '(1) 65a1b2c3d4e5f6a7b8c9d0e1', 'Document', true],
      ['0/_id', 1, '_id', 'ObjectId', false],
      ['0/list', 1, 'list', 'Array', true],
      ['0/list/0', 2, '[0]', 'Int32', false],
      ['0/list/1', 2, '[1]', 'Document', true],
      ['0/list/1/a', 3, 'a', 'Int32', false],
      ['1', 0, '(2)', 'Document', false],
    ]);
  });
});
