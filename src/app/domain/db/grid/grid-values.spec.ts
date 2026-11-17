import { describe, expect, it } from 'vitest';
import { DEFAULT_VALUE } from '../edits';
import type { ResultColumn } from '../results';
import { calculate, groupRows } from './calc';
import { dateForms, formatCell, hexDump, imageType, readGridFormats, truncation } from './cells';
import { copyAs, jsonValue, sqlLiteral } from './copy';
import { clickSelection, moveSelection, selectedRange, startSelection } from './selection';
import { compareValues, emptyView, moveColumn, shownRows } from './view';

const column = (name: string, extra: Partial<ResultColumn> = {}): ResultColumn => ({
  name,
  typeName: 'text',
  kind: 'text',
  ...extra,
});
const postgres = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
const tsql = { name: 'tsql', quoteOpen: '[', quoteClose: ']' };
const mysql = { name: 'mysql', quoteOpen: '`', quoteClose: '`' };

describe('values copied from the grid', () => {
  it('are JSON by their class', () => {
    expect(jsonValue([1, null, { $t: 'integer', v: '2' }])).toEqual([1, null, 2]);
    expect(jsonValue({ $t: 'json', v: '{"a":1}' })).toEqual({ a: 1 });
    expect(jsonValue({ $t: 'json', v: '{bad' })).toBe('{bad');
    expect(jsonValue({ $t: 'json', v: 3 })).toBe('3');
    expect(jsonValue({ $t: 'integer', v: '9007199254740993' })).toBe('9007199254740993');
    expect(jsonValue({ $t: 'decimal', v: '1.5' })).toBe(1.5);
    expect(jsonValue({ $t: 'uuid', v: 'u' })).toBe('u');
  });

  it('are literals of each engine', () => {
    expect(sqlLiteral({ $t: 'boolean', v: 'true' }, tsql)).toBe('1');
    expect(sqlLiteral(false, tsql)).toBe('0');
    expect(sqlLiteral({ $t: 'boolean', v: 'false' }, postgres)).toBe('FALSE');
    expect(sqlLiteral(true, postgres)).toBe('TRUE');
    expect(sqlLiteral({ $t: 'binary', v: 'AQI=' }, tsql)).toBe('0x0102');
    expect(sqlLiteral({ $t: 'binary', v: 'AQI=' }, postgres)).toBe("'\\x0102'");
    expect(sqlLiteral({ $t: 'binary', v: 'AQI=' }, mysql)).toBe("X'0102'");
    expect(sqlLiteral({ $t: 'binary' }, mysql)).toBe("X''");
    expect(sqlLiteral(['a b', null, ['x'], 'NULL', 'q"'], postgres)).toBe(
      `'{"a b",NULL,{x},"NULL","q\\""}'`,
    );
    expect(sqlLiteral({ $t: 'array', v: ['a'] }, postgres)).toBe("'{a}'");
    expect(sqlLiteral({ $t: 'array' }, postgres)).toBe("'{}'");
    expect(sqlLiteral("O'Brien", mysql)).toBe("'O''Brien'");
  });

  it('are UPDATE and DELETE statements named by the key, or by every value', () => {
    const keyed = {
      columns: [
        column('id', { key: true, origin: { schema: 'shop', table: 'orders', column: 'id' } }),
        column('Total', { origin: { schema: 'shop', table: 'orders', column: 'total' } }),
        column('note', { origin: { schema: 'shop', table: 'orders' } }),
      ],
      rows: [[1, 10, null]],
    };
    expect(copyAs(keyed, 'update', postgres)).toBe(
      'UPDATE shop.orders SET total = 10, note = NULL WHERE id = 1;',
    );
    expect(copyAs(keyed, 'delete', postgres)).toBe('DELETE FROM shop.orders WHERE id = 1;');
    const loose = { columns: [column('a'), column('b')], rows: [['x', null]] };
    expect(copyAs(loose, 'delete')).toBe("DELETE FROM table_name WHERE a = 'x' AND b IS NULL;");
    expect(copyAs(loose, 'update')).toBe(
      "UPDATE table_name SET a = 'x', b = NULL WHERE a = 'x' AND b IS NULL;",
    );
    expect(copyAs(loose, 'insert')).toBe("INSERT INTO table_name (a, b) VALUES ('x', NULL);");
    expect(copyAs(loose, 'in')).toBe("('x', NULL)");
  });
});

describe('cells of the grid', () => {
  it('read their formats defensively', () => {
    expect(readGridFormats('null')).toEqual({ nullText: 'NULL', decimal: '.', dates: 'iso' });
    expect(readGridFormats(undefined).nullText).toBe('NULL');
    expect(readGridFormats('{bad').decimal).toBe('.');
    expect(readGridFormats('{"nullText":"-","decimal":",","dates":"local"}')).toEqual({
      nullText: '-',
      decimal: ',',
      dates: 'local',
    });
  });

  it('write each class of value', () => {
    expect(formatCell(DEFAULT_VALUE)).toEqual({ text: 'DEFAULT', kind: 'null' });
    expect(formatCell({ $t: 'boolean', v: 'true' }).kind).toBe('boolean');
    expect(formatCell({ $t: 'date', v: '2026-01-02' })).toEqual({
      text: '2026-01-02',
      kind: 'date',
    });
    expect(formatCell({ $t: 'time', v: '10:00' }).kind).toBe('date');
    const local = { nullText: 'NULL', decimal: '.' as const, dates: 'local' as const };
    expect(formatCell({ $t: 'timestamp', v: 'not a date' }, local).text).toBe('not a date');
    expect(formatCell({ $t: 'timestamp', v: '2026-01-02T03:04:05Z' }, local).text).not.toBe(
      '2026-01-02T03:04:05Z',
    );
    expect(formatCell({ $t: 'date', v: '2026-01-02' }, local).text).toBe('2026-01-02');
    expect(formatCell({ $t: 'binary', size: 2048 }).text).toBe('[2.0 KB]');
    expect(formatCell({ $t: 'binary', size: 3 * 1024 * 1024 }).text).toBe('[3.0 MB]');
    expect(formatCell({ $t: 'binary', v: 5 }).text).toBe('[0 B]');
    expect(formatCell('x'.repeat(501)).text).toHaveLength(501);
    expect(formatCell('a\nb').text).toBe('a↵b');
  });

  it('tell a cut value, an image and the forms of a date', () => {
    expect(truncation(undefined)).toEqual({ truncated: false });
    expect(truncation({ truncated: true, size: 9 })).toEqual({ truncated: true, size: 9 });
    expect(hexDump(new Uint8Array(40), 16).split('\n').at(-1)).toBe('… 24 B');
    expect(imageType(Uint8Array.from([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg');
    expect(imageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45]);
    expect(imageType(webp)).toBe('image/webp');
    expect(imageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0]))).toBe(
      undefined,
    );
    expect(dateForms('never')).toEqual([{ label: 'As stored', text: 'never' }]);
    expect(dateForms('2026-01-02T00:00:00Z').map((form) => form.label)).toContain('Unix time (ms)');
  });
});

describe('the selection of the grid', () => {
  const options = { rows: 10, columns: 5, page: 4, ctrl: false, extend: false };
  const at = (row: number, column: number) => ({
    active: { row, column },
    anchor: { row, column },
    mode: 'cells' as const,
  });

  it('moves with every key, Ctrl to the edges', () => {
    expect(moveSelection(at(3, 3), 'ArrowUp', options)?.active).toEqual({ row: 2, column: 3 });
    expect(moveSelection(at(3, 3), 'ArrowUp', { ...options, ctrl: true })?.active.row).toBe(0);
    expect(moveSelection(at(3, 3), 'ArrowRight', { ...options, ctrl: true })?.active.column).toBe(
      4,
    );
    expect(moveSelection(at(3, 3), 'ArrowLeft', { ...options, ctrl: true })?.active.column).toBe(0);
    expect(moveSelection(at(3, 3), 'Home', options)?.active).toEqual({ row: 3, column: 0 });
    expect(moveSelection(at(3, 3), 'Home', { ...options, ctrl: true })?.active).toEqual({
      row: 0,
      column: 0,
    });
    expect(moveSelection(at(3, 3), 'End', options)?.active).toEqual({ row: 3, column: 4 });
    expect(moveSelection(at(3, 3), 'End', { ...options, ctrl: true })?.active.row).toBe(9);
    expect(moveSelection(at(3, 3), 'PageUp', options)?.active.row).toBe(0);
    expect(moveSelection(at(3, 3), 'Tab', options)).toBeUndefined();
    expect(moveSelection(at(3, 3), 'ArrowUp', { ...options, rows: 0 })).toBeUndefined();
    const extended = moveSelection(at(3, 3), 'ArrowDown', { ...options, extend: true });
    expect(extended?.anchor).toEqual({ row: 3, column: 3 });
  });

  it('covers whole columns and keeps the anchor of a click with Shift', () => {
    const columns = {
      active: { row: 2, column: 1 },
      anchor: { row: 5, column: 3 },
      mode: 'columns' as const,
    };
    expect(selectedRange(columns, 10, 5)).toEqual({ top: 0, bottom: 9, left: 1, right: 3 });
    const clicked = clickSelection(startSelection(), { row: 4, column: 2 }, 'cells', true);
    expect(clicked.anchor).toEqual({ row: 0, column: 0 });
  });
});

describe('the order and figures of the grid', () => {
  it('orders numbers, texts and NULL last', () => {
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(null, 1)).toBe(1);
    expect(compareValues(1, null)).toBe(-1);
    expect(compareValues({ $t: 'decimal', v: 'x' }, { $t: 'decimal', v: 'y' })).toBeLessThan(0);
    const rows = [[2], [1], [2]];
    expect(shownRows(rows, { ...emptyView(), sort: { column: 0, descending: true } })).toEqual([
      0, 2, 1,
    ]);
  });

  it('moves a column before or after another, from any order', () => {
    expect(moveColumn(emptyView(), 3, 0, 2, true).order).toEqual([1, 2, 0]);
    expect(moveColumn({ ...emptyView(), order: [2, 1, 0] }, 3, 2, 0, false).order).toEqual([
      1, 2, 0,
    ]);
  });

  it('calculates over typed numbers and groups by frequency, then by value', () => {
    expect(calculate([{ $t: 'integer', v: '2' }, 1])).toMatchObject({ sum: 3, min: '1', max: '2' });
    expect(calculate([])).toEqual({ count: 0, distinct: 0, nulls: 0 });
    expect(groupRows([['b'], ['a'], ['b'], ['c']], [0])).toEqual([
      { values: ['b'], count: 2 },
      { values: ['a'], count: 1 },
      { values: ['c'], count: 1 },
    ]);
  });
});
