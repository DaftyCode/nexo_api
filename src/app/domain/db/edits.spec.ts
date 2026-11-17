import {
  DEFAULT_VALUE,
  addRow,
  changeCount,
  deleteRows,
  duplicateRows,
  editability,
  marks,
  noEdits,
  rowChanges,
  setCell,
  shownRows,
  undo,
} from './edits';
import { editScript, parseInput, tsvBlock } from './edits-sql';
import { ResultColumn } from './results';

const column = (name: string, kind: string, extra: Partial<ResultColumn> = {}): ResultColumn => ({
  name,
  typeName: kind,
  kind,
  origin: { schema: 'shop', table: 'orders', column: name },
  ...extra,
});
const columns = [
  column('id', 'integer', { key: true }),
  column('total', 'decimal'),
  column('note', 'text'),
];
const rows = [
  [1, { $t: 'decimal', v: '9.99' }, 'a'],
  [2, { $t: 'decimal', v: '5.00' }, null],
];

describe('rows edited in the grid', () => {
  it('can be edited only with one table and the key of each row', () => {
    expect(editability(columns, { readOnly: false })).toEqual({
      target: { schema: 'shop', table: 'orders', key: [0] },
    });
    expect(editability(columns, { readOnly: true }).reason).toBe('db.edit.readOnly');
    const joined = [...columns, { ...column('name', 'text'), origin: { table: 'customers' } }];
    expect(editability(joined, { readOnly: false }).reason).toBe('db.edit.notOneTable');
    const keyless = columns.map((each) => ({ ...each, key: false }));
    expect(editability(keyless, { readOnly: false }).reason).toBe('db.edit.noKey');
    expect(editability(keyless, { readOnly: false, virtualKey: ['note'] })).toEqual({
      target: { schema: 'shop', table: 'orders', key: [2] },
    });
    const computed = [{ name: 'n', typeName: 'int', kind: 'integer' }];
    expect(editability(computed, { readOnly: false }).reason).toBe('db.edit.notOneTable');
  });

  it('keeps changed cells, new and deleted rows pending, each step undoable', () => {
    let history = setCell(noEdits(), 2, 0, 1, { $t: 'decimal', v: '10.50' });
    history = addRow(history, 3);
    history = setCell(history, 2, 2, 2, 'new');
    history = deleteRows(history, 2, [1]);
    expect(changeCount(history.now)).toBe(3);
    const shown = shownRows(rows, history.now);
    expect(shown[0][1]).toEqual({ $t: 'decimal', v: '10.50' });
    expect(shown[2]).toEqual([DEFAULT_VALUE, DEFAULT_VALUE, 'new']);
    const marked = marks(2, history.now);
    expect(marked.get(0)).toEqual({ kind: 'changed', cells: new Set([1]) });
    expect(marked.get(1)?.kind).toBe('deleted');
    expect(marked.get(2)?.kind).toBe('new');
    history = undo(history);
    expect(history.now.deletes.size).toBe(0);
    // A copy leaves its key to the default; a new row deleted is just dropped.
    history = duplicateRows(history, shown, [0], [0]);
    expect(history.now.inserts[1][0]).toBe(DEFAULT_VALUE);
    history = deleteRows(history, 2, [3]);
    expect(history.now.inserts).toHaveLength(1);
  });

  it('sends updates, new rows and deletes with their keys and originals', () => {
    let history = setCell(noEdits(), 2, 1, 2, 'filled');
    history = addRow(history, 3);
    history = setCell(history, 2, 2, 2, 'x');
    history = deleteRows(history, 2, [0]);
    const target = { schema: 'shop', table: 'orders', key: [0] };
    const changes = rowChanges(columns, rows, history.now, target);
    expect(changes).toEqual([
      {
        kind: 'update',
        key: [{ column: 'id', value: 2 }],
        values: [{ column: 'note', value: 'filled' }],
        original: [{ column: 'note', value: null }],
      },
      {
        kind: 'insert',
        values: [
          { column: 'id', value: null, default: true },
          { column: 'total', value: null, default: true },
          { column: 'note', value: 'x' },
        ],
      },
      {
        kind: 'delete',
        key: [{ column: 'id', value: 1 }],
        original: [
          { column: 'id', value: 1 },
          { column: 'total', value: { $t: 'decimal', v: '9.99' } },
          { column: 'note', value: 'a' },
        ],
      },
    ]);
    const style = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
    expect(editScript(target, changes, style).split('\n')).toEqual([
      "UPDATE shop.orders SET note = 'filled' WHERE id = 2;",
      "INSERT INTO shop.orders (note) VALUES ('x');",
      'DELETE FROM shop.orders WHERE id = 1;',
    ]);
  });

  it('reads what was typed as a value of the column, or says why it does not fit', () => {
    expect(parseInput('42', column('a', 'integer'))).toEqual({ value: 42 });
    expect(parseInput('12345678901234567890', column('a', 'integer'))).toEqual({
      value: { $t: 'integer', v: '12345678901234567890' },
    });
    expect(parseInput('4.5x', column('a', 'decimal')).error).toBe('db.edit.notNumber');
    expect(parseInput('{"a": 1}', column('a', 'json'))).toEqual({
      value: { $t: 'json', v: '{"a": 1}' },
    });
    expect(parseInput('{a', column('a', 'json')).error).toBe('db.edit.notJson');
    expect(parseInput('2026-11-16', column('a', 'date'))).toEqual({
      value: { $t: 'date', v: '2026-11-16' },
    });
    expect(parseInput('yes', column('a', 'boolean'))).toEqual({ value: true });
    expect(parseInput(' kept ', column('a', 'text'))).toEqual({ value: ' kept ' });
    expect(tsvBlock('a\tb\r\nc\td\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});
