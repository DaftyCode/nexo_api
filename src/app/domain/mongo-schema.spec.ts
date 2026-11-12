import {
  FieldSchema,
  SchemaReport,
  fieldNames,
  percent,
  presence,
  queryPath,
  schemaCsv,
  schemaMarkdown,
  valueFilter,
  valueText,
} from './mongo-schema';

const field = (path: string, overrides: Partial<FieldSchema> = {}): FieldSchema => ({
  path,
  name: path.split('.').at(-1)!,
  depth: path.split('.').length - 1,
  count: 10,
  parents: 10,
  types: [{ name: 'String', count: 10 }],
  values: [],
  distinct: 0,
  distinctCapped: false,
  anomalies: [],
  ...overrides,
});

const report: SchemaReport = {
  sampled: 20,
  truncated: false,
  elapsedMs: 3,
  validator: {},
  jsonSchema: {},
  fields: [
    field('age', {
      count: 19,
      parents: 20,
      types: [
        { name: 'Int32', count: 18 },
        { name: 'String', count: 1 },
      ],
      values: [{ value: { $numberInt: '30' }, count: 4 }],
      distinct: 12,
      anomalies: ['mixedTypes', 'sometimesMissing'],
    }),
    field('items'),
    field('items.[]'),
    field('items.[].sku', { values: [{ value: 'A|B', count: 2 }], distinctCapped: true }),
  ],
};

describe('MongoDB schemas', () => {
  it('turns shares into percentages', () => {
    expect(presence(report.fields[0])).toBe(95);
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(1, 0)).toBe(0);
  });

  it('names fields as a query does, and filters by a value', () => {
    expect(queryPath('items.[].sku')).toBe('items.sku');
    expect(queryPath('tags.[]')).toBe('tags');
    expect(valueFilter(report.fields[3], 'A')).toBe('{ "items.sku": "A" }');
    expect(valueFilter(report.fields[0], { $numberInt: '30' })).toBe('{ "age": NumberInt(30) }');
    expect(valueText({ a: 'x'.repeat(100) })).toHaveLength(80);
  });

  it('writes the schema as CSV and Markdown', () => {
    const csv = schemaCsv(report).split('\n');
    expect(csv[0]).toBe('field,presence %,types,anomalies,distinct values,frequent values');
    expect(csv[1]).toBe(
      'age,95,"Int32 94.7%, String 5.3%","mixedTypes, sometimesMissing",12,NumberInt(30) (4)',
    );
    expect(csv[4]).toBe('items.[].sku,100,String 100%,,0+,"""A|B"" (2)"');
    const markdown = schemaMarkdown(report, 'shop.people');
    expect(markdown).toContain('# shop.people\n\n20 documents sampled.');
    expect(markdown).toContain(
      '| age | 95% | Int32 94.7%, String 5.3% | mixedTypes, sometimesMissing |',
    );
  });

  it('suggests the fields of the schema and of the documents shown', () => {
    expect(
      fieldNames(report, [
        { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, customer: { address: { city: 'Lugo' } } },
      ]),
    ).toEqual([
      'age',
      'items',
      'items.sku',
      '_id',
      'customer',
      'customer.address',
      'customer.address.city',
    ]);
    expect(fieldNames(undefined)).toEqual([]);
  });
});
