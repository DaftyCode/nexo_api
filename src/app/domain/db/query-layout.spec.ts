import { describe, expect, it } from 'vitest';
import { QueryModel, emptyQuery } from './query-model';
import { BOX, boxWidth, builderLayout, knownTable } from './query-model/layout';

const known = [
  { path: ['a'], schema: 'public', name: 'orders', columns: ['id', 'user_id'], keys: [] },
  { path: ['b'], name: 'Users', columns: ['id'], keys: [] },
  { path: ['c'], name: 'towns', columns: [], keys: [] },
  { path: ['d'], name: 'lines', columns: ['id'], keys: [] },
];
const expression = (alias: string, column: string) => `${alias}.${column}`;

describe('the layout of the canvas', () => {
  it('finds the table a model names, by name and schema, quotes aside', () => {
    expect(knownTable({ path: ['public', 'orders'], alias: '' }, known)?.path).toEqual(['a']);
    expect(knownTable({ path: ['other', 'orders'], alias: '' }, known)).toBeUndefined();
    expect(knownTable({ path: ['users'], alias: '' }, known)?.path).toEqual(['b']);
  });

  it('makes each table as wide as its text, within limits, and the next one starts after it', () => {
    expect(boxWidth('t', 't', ['id'])).toBe(BOX.width);
    const wide = boxWidth('public.lpc_users', 'lpc_users', ['id', 'whatsapp_consent']);
    expect(wide).toBe(Math.round(25 * BOX.char + BOX.padding));
    expect(boxWidth('x', '', ['a'.repeat(200)])).toBe(BOX.maxWidth);
    const long = [{ path: ['p'], schema: 'public', name: 'lpc_users', columns: ['id'], keys: [] }];
    const model: QueryModel = {
      ...emptyQuery(),
      tables: [
        { path: ['public', 'lpc_users'], alias: '' },
        { path: ['public', 'lpc_users'], alias: 'u2' },
      ],
    };
    const layout = builderLayout(model, long, expression);
    const first = layout.tables[0];
    expect(first.width).toBe(boxWidth('public.lpc_users', 'lpc_users', ['id']));
    expect(layout.tables[1].x).toBe(first.width + BOX.gapX);
    expect(layout.width).toBe(layout.tables[1].x + layout.tables[1].width);
  });

  it('lays tables out in rows of three and draws each comparison of a join', () => {
    const model: QueryModel = {
      ...emptyQuery(),
      tables: [
        { path: ['orders'], alias: 'o' },
        { path: ['users'], alias: 'U' },
        { path: ['towns'], alias: '' },
        { path: ['lines'], alias: 'l' },
        { path: ['gone'], alias: 'g' },
      ],
      joins: [
        { table: 1, kind: 'left', on: [{ left: '"U".id', operator: '=', right: 'o.user_id' }] },
        { table: 2, kind: 'inner', on: [{ left: 'towns.x', operator: '=', right: 'o.id' }] },
        { table: 3, kind: 'inner', on: [{ left: 'l.id', operator: '=', right: 'o.id' }] },
        {
          table: 4,
          kind: 'inner',
          on: [
            { left: 'nowhere.id', operator: '=', right: 'o.id' },
            { left: 'o.id', operator: '=', right: 'o.user_id' },
          ],
        },
      ],
    };
    const layout = builderLayout(model, known, expression);
    expect(layout.tables.map((table) => [table.alias, table.x, table.y])).toEqual([
      ['o', 0, 0],
      ['U', BOX.width + BOX.gapX, 0],
      ['towns', 2 * (BOX.width + BOX.gapX), 0],
      ['l', 0, BOX.header + 2 * BOX.row + BOX.gapY],
      ['g', BOX.width + BOX.gapX, BOX.header + 2 * BOX.row + BOX.gapY],
    ]);
    expect(layout.tables[0].columns[1]).toEqual({
      name: 'user_id',
      expression: 'o.user_id',
      y: BOX.header + BOX.row + BOX.row / 2,
    });
    // From the right side of the left table to the left side of the right one; a column
    // that is not there is drawn from the header; one above another, from the left sides.
    expect(layout.lines).toEqual([
      {
        table: 1,
        kind: 'left',
        x1: BOX.width,
        y1: BOX.header + BOX.row * 1.5,
        x2: BOX.width + BOX.gapX,
        y2: BOX.header + BOX.row / 2,
      },
      {
        table: 2,
        kind: 'inner',
        x1: BOX.width,
        y1: BOX.header + BOX.row / 2,
        x2: 2 * (BOX.width + BOX.gapX),
        y2: BOX.header / 2,
      },
      expect.objectContaining({ table: 3, x1: 0, x2: 0 }),
    ]);
    expect(layout.width).toBe(3 * BOX.width + 2 * BOX.gapX);
    expect(builderLayout(emptyQuery(), [], expression)).toMatchObject({
      width: BOX.width,
      height: BOX.header,
      lines: [],
    });
  });
});
