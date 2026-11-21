import {
  alike,
  definitionLines,
  namesOf,
  readDataComparison,
  readSchemaComparison,
  readWarnings,
  shownValue,
  tableOf,
} from './compare';

describe('comparing databases', () => {
  it('reads the structure compared, leaving out what it does not know', () => {
    const read = readSchemaComparison({
      between: true,
      objects: [
        { kind: 'table', name: 'a', status: 'different', differences: [{ part: 'column' }] },
        { kind: 'view', name: 'v', status: 'equal' },
        { kind: 'table', name: 'x', status: 'strange' },
      ],
      counts: { different: 1, equal: 1 },
    });
    expect(read.between).toBe(true);
    expect(read.objects.map((object) => object.name)).toEqual(['a', 'v']);
    expect(read.objects[1].differences).toEqual([]);
    expect(read.counts).toEqual({
      different: 1,
      onlySource: 0,
      onlyTarget: 0,
      equivalent: 0,
      equal: 1,
    });
    expect(alike(read)).toBe(false);
    expect(
      alike(
        readSchemaComparison({ objects: [{ kind: 'table', name: 'a', status: 'equivalent' }] }),
      ),
    ).toBe(true);
    expect(readSchemaComparison(undefined).objects).toEqual([]);
  });

  it('reads the data compared', () => {
    const read = readDataComparison({
      counts: { onlySource: 2, different: 1 },
      key: ['id'],
      columns: ['qty'],
      differences: [
        { kind: 'different', key: [1], source: [1, 5], target: [1, 6], columns: ['qty'] },
      ],
      complete: false,
    });
    expect(read.counts).toEqual({ onlySource: 2, onlyTarget: 0, different: 1, equal: 0 });
    expect(read.complete).toBe(false);
    expect(readDataComparison(null)).toMatchObject({
      key: [],
      columns: [],
      differences: [],
      complete: true,
    });
  });

  it('reads the warnings of a script, texts of the catalogs with their values', () => {
    expect(
      readWarnings(['plain', { text: 'db.compare.warn.checks', params: { v0: 'orders' } }, 7, {}]),
    ).toEqual([
      { text: 'plain', params: {} },
      { text: 'db.compare.warn.checks', params: { v0: 'orders' } },
    ]);
    expect(readWarnings(undefined)).toEqual([]);
  });

  it('finds a table by its path and marks the lines each definition lacks', () => {
    expect(tableOf(['shop', 'schemas', 'sales', 'tables', 'orders'])).toEqual({
      schema: 'sales',
      table: 'orders',
    });
    expect(tableOf(['databases', 'shop', 'tables', 'orders'])).toEqual({
      schema: 'shop',
      table: 'orders',
    });
    expect(tableOf(['tables', 'orders'])).toEqual({ table: 'orders' });
    const [source, target] = definitionLines(
      'CREATE TABLE t (\n  a int,\n  b text\n)',
      'CREATE TABLE t (\n  a int\n)',
    );
    expect(source.map((line) => line.changed)).toEqual([false, false, true, false]);
    expect(target.map((line) => line.changed)).toEqual([false, false, false]);
    expect(shownValue(null)).toBe('NULL');
    expect(shownValue({ $t: 'decimal', v: '1.50' })).toBe('1.50');
    expect(shownValue('a')).toBe('a');
    expect(shownValue(5)).toBe('5');
    expect(namesOf(' id, , code ')).toEqual(['id', 'code']);
  });
});
