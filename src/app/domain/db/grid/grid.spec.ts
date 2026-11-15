import { calculate, groupRows } from './calc';
import { formatCell, hexDump, imageType, prettyJson, prettyXml, truncation } from './cells';
import { copyAs, sourceTable, sqlLiteral } from './copy';
import { isSelected, moveSelection, selectedRange, startSelection } from './selection';
import { plainText } from './text';
import { columnWindow, emptyView, nextSort, rowWindow, shownColumns, shownRows } from './view';

const integer = (v: number) => ({ $t: 'integer', v: String(v) });
const columns = [
  {
    name: 'id',
    typeName: 'int8',
    kind: 'integer',
    origin: { schema: 'shop', table: 'orders', column: 'id' },
  },
  {
    name: 'note',
    typeName: 'text',
    kind: 'text',
    origin: { schema: 'shop', table: 'orders', column: 'note' },
  },
];
const postgres = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
const tsql = { name: 'tsql', quoteOpen: '[', quoteClose: ']' };

describe('the data grid', () => {
  it('writes each class of value as DBeaver does', () => {
    expect(formatCell(null)).toEqual({ text: 'NULL', kind: 'null' });
    expect(formatCell(null, { nullText: '∅', decimal: '.', dates: 'iso' }).text).toBe('∅');
    expect(
      formatCell({ $t: 'decimal', v: '10.50' }, { nullText: '', decimal: ',', dates: 'iso' }),
    ).toEqual({
      text: '10,50',
      kind: 'number',
    });
    expect(formatCell({ $t: 'binary', v: 'AAECAw==' })).toEqual({ text: '[4 B]', kind: 'binary' });
    expect(formatCell({ $t: 'binary', v: 'AA==', truncated: true, size: 2048 }).text).toBe(
      '[2.0 KB]',
    );
    expect(formatCell({ $t: 'json', v: `{"a": ${'1'.repeat(100)}}` }).text).toHaveLength(81);
    expect(formatCell('two\nlines').text).toBe('two↵lines');
    expect(truncation({ $t: 'text', v: 'a', truncated: true, size: 9 })).toEqual({
      truncated: true,
      size: 9,
    });
  });

  it('lays out JSON and XML and dumps binaries', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('not json')).toBe('not json');
    expect(prettyXml('<a><b>x</b><c/></a>')).toBe('<a>\n  <b>x</b>\n  <c/>\n</a>');
    expect(hexDump(new Uint8Array([0x41, 0x42, 0x00]))).toBe(
      `00000000  41 42 00${' '.repeat(39)}  AB.`,
    );
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(imageType(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('orders, hides and pins columns, and filters and sorts the loaded rows', () => {
    const view = { ...emptyView(), order: [2, 0, 1], hidden: [1], pinned: [0] };
    expect(shownColumns(view, 3)).toEqual([0, 2]);
    const rows = [
      [integer(10), 'b'],
      [integer(9), null],
      [integer(100), 'a'],
    ];
    expect(shownRows(rows, { ...emptyView(), sort: { column: 0, descending: false } })).toEqual([
      1, 0, 2,
    ]);
    expect(shownRows(rows, { ...emptyView(), sort: { column: 1, descending: false } })).toEqual([
      2, 0, 1,
    ]);
    expect(shownRows(rows, { ...emptyView(), filter: 'B' })).toEqual([0]);
    expect(nextSort(undefined, 1)).toEqual({ column: 1, descending: false });
    expect(nextSort({ column: 1, descending: false }, 1)).toEqual({ column: 1, descending: true });
    expect(nextSort({ column: 1, descending: true }, 1)).toBeUndefined();
  });

  it('draws only what is in sight', () => {
    expect(rowWindow(2600, 260, 26, 100_000)).toEqual({ first: 94, last: 116 });
    expect(columnWindow([100, 100, 100, 100, 100], 250, 120)).toEqual({
      first: 0,
      last: 5,
      offset: 0,
    });
    expect(columnWindow(Array(200).fill(100), 10_000, 300, 1)).toEqual({
      first: 98,
      last: 104,
      offset: 9800,
    });
  });

  it('moves and extends the selection with the keyboard', () => {
    const options = { rows: 10, columns: 4, page: 5, ctrl: false, extend: false };
    let selection = moveSelection(startSelection(), 'ArrowDown', options)!;
    expect(selection.active).toEqual({ row: 1, column: 0 });
    selection = moveSelection(selection, 'End', { ...options, extend: true })!;
    expect(selectedRange(selection, 10, 4)).toEqual({ top: 1, bottom: 1, left: 0, right: 3 });
    selection = moveSelection(selection, 'ArrowDown', { ...options, ctrl: true })!;
    expect(selection.active).toEqual({ row: 9, column: 3 });
    expect(moveSelection(selection, 'PageDown', options)!.active.row).toBe(9);
    const rows = { ...selection, mode: 'rows' as const };
    expect(isSelected(rows, 10, 4, 9, 0)).toBe(true);
    expect(moveSelection(startSelection(), 'x', options)).toBeUndefined();
  });

  it('copies cells in every format', () => {
    const cells = {
      columns,
      rows: [
        [integer(1), 'it\'s, "here"'],
        [integer(2), null],
      ],
    };
    expect(copyAs(cells, 'text-headers')).toBe('id\tnote\n1\tit\'s, "here"\n2\tNULL');
    expect(copyAs(cells, 'csv')).toBe('id,note\r\n1,"it\'s, ""here"""\r\n2,NULL');
    expect(JSON.parse(copyAs(cells, 'json'))).toEqual([
      { id: 1, note: 'it\'s, "here"' },
      { id: 2, note: null },
    ]);
    expect(copyAs(cells, 'markdown').split('\n')[1]).toBe('| --- | --- |');
    expect(
      copyAs({ columns: [columns[0]], rows: [[integer(1)], [integer(1)], [integer(2)]] }, 'in'),
    ).toBe('(1, 2)');
    expect(copyAs(cells, 'insert', postgres)).toBe(
      "INSERT INTO shop.orders (id, note) VALUES (1, 'it''s, \"here\"');\nINSERT INTO shop.orders (id, note) VALUES (2, NULL);",
    );
    expect(
      sourceTable([columns[0], { name: 'x', typeName: '', kind: 'text' }], postgres),
    ).toBeUndefined();
  });

  it('writes literals for each engine', () => {
    expect(sqlLiteral({ $t: 'binary', v: 'AQI=' }, postgres)).toBe("'\\x0102'");
    expect(sqlLiteral({ $t: 'binary', v: 'AQI=' }, tsql)).toBe('0x0102');
    expect(sqlLiteral(true, tsql)).toBe('1');
    expect(sqlLiteral(true, postgres)).toBe('TRUE');
    expect(sqlLiteral(['a b', null, 'c'], postgres)).toBe(`'{"a b",NULL,c}'`);
    expect(sqlLiteral({ $t: 'timestamptz', v: '2026-01-01T00:00:00Z' }, postgres)).toBe(
      "'2026-01-01T00:00:00Z'",
    );
  });

  it('figures the selected cells and groups the loaded rows', () => {
    expect(calculate([integer(2), integer(4), null, integer(4)])).toEqual({
      count: 4,
      distinct: 2,
      nulls: 1,
      sum: 10,
      average: 10 / 3,
      min: '2',
      max: '4',
    });
    expect(calculate(['b', 'a'])).toEqual({ count: 2, distinct: 2, nulls: 0, min: 'a', max: 'b' });
    expect(
      groupRows(
        [
          ['x', 1],
          ['y', 2],
          ['x', 3],
        ],
        [0],
      ),
    ).toEqual([
      { values: ['x'], count: 2 },
      { values: ['y'], count: 1 },
    ]);
  });

  it('writes the rows as aligned text', () => {
    const text = plainText(columns, [[integer(1), 'abc']], [0, 1], [0], {
      nullText: 'NULL',
      decimal: '.',
      dates: 'iso',
    });
    expect(text).toBe(['id | note', '---+-----', '1  | abc '].join('\n'));
  });
});
