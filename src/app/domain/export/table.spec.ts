import { RunReport } from '../reports';
import { MAX_TABLE_COLUMNS, bodyRecords, csvText, flatten, recordsOf, runRecords } from './table';

describe('tables to export', () => {
  it('finds the records of a JSON value', () => {
    expect(recordsOf([{ a: 1 }, { b: 2 }])).toEqual({ records: [{ a: 1 }, { b: 2 }], name: '' });
    expect(recordsOf({ total: 2, data: [{ a: 1 }] })).toEqual({
      records: [{ a: 1 }],
      name: 'data',
    });
    // Two lists, an empty one, items that are not objects or nothing: none.
    expect(recordsOf({ a: [{ x: 1 }], b: [{ y: 1 }] })).toBeUndefined();
    expect(recordsOf([])).toBeUndefined();
    expect(recordsOf([1, 2])).toBeUndefined();
    expect(recordsOf([{ a: 1 }, null])).toBeUndefined();
    expect(recordsOf('text')).toBeUndefined();
    expect(bodyRecords('[{"id":1}]')?.records).toEqual([{ id: 1 }]);
    expect(bodyRecords('not json')).toBeUndefined();
  });

  it('flattens embedded objects into dotted columns, in the order first seen', () => {
    const table = flatten([
      { id: 1, customer: { name: 'Ana', address: { city: 'Lima' } }, tags: ['a', 'b'] },
      { id: 2, customer: {}, extra: null, nested: { list: [{ x: 1 }] } },
      'not a record',
    ]);
    expect(table.columns).toEqual([
      'id',
      'customer.name',
      'customer.address.city',
      'tags',
      'customer',
      'extra',
      'nested.list',
    ]);
    expect(table.rows).toEqual([
      [1, 'Ana', 'Lima', '["a","b"]', null, null, null],
      [2, null, null, null, '{}', null, '[{"x":1}]'],
      [null, null, null, null, null, null, null],
    ]);
    expect(table.cut).toBe(false);
  });

  it('keeps a bounded number of columns', () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_TABLE_COLUMNS + 5 }, (_, at) => [`c${at}`, at]),
    );
    const table = flatten([wide]);
    expect(table.columns.length).toBe(MAX_TABLE_COLUMNS);
    expect(table.cut).toBe(true);
  });

  it('turns a run into one record per request and iteration', () => {
    const report: RunReport = {
      collection: 'Shop',
      state: 'completed',
      duration: 30,
      totals: { requests: 2, failedRequests: 1, passed: 1, failed: 1, skipped: 1 },
      requests: [
        {
          name: 'List',
          method: 'GET',
          url: 'https://api.test/orders',
          iteration: 0,
          status: 200,
          statusText: 'OK',
          time: 12,
          failed: false,
          assertions: [
            { name: 'is ok', passed: true, skipped: false },
            { name: 'later', passed: false, skipped: true },
          ],
        },
        {
          name: 'Create',
          method: 'POST',
          url: 'https://api.test/orders',
          iteration: 1,
          status: 500,
          statusText: 'Error',
          time: 18,
          error: 'boom',
          failed: true,
          assertions: [
            { name: 'created', passed: false, skipped: false, error: 'expected 201' },
            { name: 'has id', passed: false, skipped: false },
          ],
        },
      ],
      other: [],
    };
    const [first, second] = runRecords(report);
    expect(first).toEqual({
      iteration: 1,
      request: 'List',
      method: 'GET',
      url: 'https://api.test/orders',
      status: 200,
      statusText: 'OK',
      timeMs: 12,
      result: 'passed',
      passed: 1,
      failed: 0,
      skipped: 1,
      failures: '',
      error: '',
    });
    expect(second).toMatchObject({
      iteration: 2,
      result: 'failed',
      failed: 2,
      failures: 'created: expected 201\nhas id',
      error: 'boom',
    });
  });

  it('writes CSV that spreadsheets read as UTF-8 and never run as formulas', () => {
    const table = {
      columns: ['name', 'note', 'formula'],
      rows: [
        ['Ana; Real', 'says "hi"\nthen', '=1+1'],
        [null, ' padded', -5],
        ['+34', '@user', 'plain'],
      ],
    };
    expect(csvText(table, ';')).toBe(
      '﻿name;note;formula\r\n' +
        '"Ana; Real";"says ""hi""\nthen";\'=1+1\r\n' +
        ';" padded";-5\r\n' +
        "'+34;'@user;plain\r\n",
    );
    expect(csvText({ columns: ['a,b'], rows: [] }, ',', false)).toBe('"a,b"\r\n');
  });
});
