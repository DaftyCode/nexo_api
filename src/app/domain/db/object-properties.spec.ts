import { propertyCards, schemaOf, sectionCount } from './object-properties';

const format = {
  date: (text: string) => `date ${text}`,
  number: (value: number) => value.toLocaleString('en'),
};
const orders = {
  name: 'shop.orders',
  properties: [
    { name: 'Kind', value: 'table' },
    { name: 'Owner', value: 'nexo' },
    { name: 'Comment', value: null },
    { name: 'Estimated rows', value: { $t: 'integer', v: '200000' } },
    { name: 'Size', value: '312 kB' },
    { name: 'Table size', value: '200 kB' },
    { name: 'Object ID', value: 16394 },
    { name: 'Persistence', value: 'permanent' },
    { name: 'Last analyze', value: { $t: 'timestamptz', v: '2026-11-16T10:00:00+00' } },
    { name: 'Fill factor', value: 90 },
  ],
  sections: [
    { id: 'columns', rows: [[1], [2], [3]] },
    { id: 'indexes', rows: [[1]] },
    { id: 'triggers', rows: [] },
  ],
};
const path = ['shop', 'schemas', 'shop', 'tables', 'orders'];

describe('the cards of the Properties view', () => {
  it('puts what identifies the object first, with its schema from its path', () => {
    const cards = propertyCards(orders, path, format);
    expect(cards.general).toEqual([
      { name: 'Qualified name', value: 'shop.orders', style: 'code', copy: true },
      { name: 'Schema', value: 'shop', style: 'code' },
      { name: 'Kind', value: 'table', style: 'tag' },
      { name: 'Owner', value: 'nexo', style: 'tag' },
      // No comment, as a dash.
      { name: 'Description', value: '—', style: 'text' },
    ]);
    expect(schemaOf(['databases', 'shop', 'schemas', 'dbo', 'tables', 'x'])).toBe('dbo');
    expect(schemaOf(['shop', 'schemas'])).toBeUndefined();
  });

  it('lists the details, the storage with the counts of its sections, and the rest', () => {
    const cards = propertyCards(orders, path, format);
    expect(cards.details).toEqual([
      { name: 'Object ID', value: '16394', style: 'code', copy: true },
      { name: 'Last analyze', value: 'date 2026-11-16T10:00:00+00', style: 'date' },
      { name: 'Persistence', value: 'permanent', style: 'tag' },
    ]);
    expect(cards.storage.map((row) => [row.name, row.value])).toEqual([
      ['Estimated rows', '200,000'],
      ['Table size', '200 kB'],
      ['Total size', '312 kB'],
      ['Columns', '3'],
      ['Indexes', '1'],
      ['Triggers', '0'],
    ]);
    expect(cards.storage[2].hint).toBe('db.props.total');
    expect(cards.more).toEqual([{ name: 'Fill factor', value: '90', style: 'text' }]);
    expect(cards.definition).toBeUndefined();
    expect(sectionCount(orders, 'columns')).toBe(3);
    expect(sectionCount(orders, 'partitions')).toBeUndefined();
  });

  it('keeps the definition of a view or a function for its own card', () => {
    const view = { ...orders, properties: [{ name: 'Definition', value: 'SELECT 1' }] };
    const cards = propertyCards(view, [], format);
    expect(cards.definition).toBe('SELECT 1');
    expect(cards.general.map((row) => row.name)).toEqual(['Qualified name', 'Description']);
    expect(cards.more).toEqual([]);
  });
});
