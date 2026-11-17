import {
  addColumn,
  changeColumn,
  columnChanged,
  newTable,
  planScript,
  readTable,
  removeColumn,
  tableChanged,
} from './structure';

describe('the structure of a table', () => {
  const read = () =>
    readTable({
      name: 'items',
      original: 'items',
      columns: [
        { name: 'id', original: 'id', typeName: 'integer', nullable: false, identity: true },
        { name: 'label', original: 'label', typeName: 'text', nullable: true },
      ],
      primaryKey: { columns: ['id'] },
      indexes: [{ name: 'items_label', columns: ['label DESC'], unique: false }],
    });

  it('reads a model with every list, and makes a new table with its key', () => {
    const table = read();
    expect(table.uniques).toEqual([]);
    expect(table.columns[1].identity).toBe(false);
    expect(newTable('orders', 'shop')).toEqual(
      expect.objectContaining({ schema: 'shop', primaryKey: { columns: ['id'] } }),
    );
  });

  it('adds, renames and removes columns, the keys and indexes following', () => {
    const added = addColumn(read());
    expect(added.columns[2].name).toBe('column3');
    expect(added.columns[2].original).toBeUndefined();
    const renamed = changeColumn(read(), 1, { name: 'title' });
    expect(renamed.columns[1].original).toBe('label');
    expect(renamed.indexes[0].columns).toEqual(['title DESC']);
    const removed = removeColumn(read(), 1);
    expect(removed.indexes).toEqual([]);
    expect(removeColumn(read(), 0).primaryKey).toBeUndefined();
  });

  it('says what changed, and writes the statements ended', () => {
    const original = read();
    const changed = changeColumn(original, 1, { typeName: 'varchar(20)' });
    expect(columnChanged(original, changed.columns[1], 'typeName')).toBe(true);
    expect(columnChanged(original, changed.columns[1], 'nullable')).toBe(false);
    expect(columnChanged(original, addColumn(original).columns[2], 'name')).toBe(true);
    expect(tableChanged(original, read())).toBe(false);
    expect(tableChanged(original, changed)).toBe(true);
    expect(planScript(['ALTER TABLE t ADD c int', 'DROP INDEX i;'])).toBe(
      'ALTER TABLE t ADD c int;\n\nDROP INDEX i;',
    );
  });
});
