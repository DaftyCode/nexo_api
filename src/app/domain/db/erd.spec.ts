import { describe, expect, it } from 'vitest';
import { ErdModel, erdModel, shownColumns, tableFromDescription, tableFromModel } from './erd';
import { ErdBox, entitySize, erdBounds, erdLayout } from './erd-layout';
import { erdScene } from './erd-scene';
import { relationLine } from './erd-paths';
import { readTable } from './structure';

const users = tableFromModel(
  readTable({
    schema: 'shop',
    name: 'users',
    columns: [
      { name: 'id', typeName: 'integer', nullable: false },
      { name: 'email', typeName: 'text', nullable: false },
    ],
    primaryKey: { columns: ['id'] },
    uniques: [{ columns: ['email'] }],
  }),
  ['shop', 'schemas', 'shop', 'tables', 'users'],
);
const orders = tableFromModel(
  readTable({
    schema: 'shop',
    name: 'orders',
    columns: [
      { name: 'id', typeName: 'integer', nullable: false },
      { name: 'user_id', typeName: 'integer', nullable: true },
      { name: 'parent', typeName: 'integer', nullable: true },
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [
      {
        name: 'orders_user',
        columns: ['user_id'],
        referencedTable: 'users',
        referencedColumns: ['id'],
      },
      {
        columns: ['parent'],
        referencedSchema: 'shop',
        referencedTable: 'orders',
        referencedColumns: ['id'],
      },
      { columns: ['x'], referencedTable: 'elsewhere', referencedColumns: ['id'] },
    ],
  }),
  ['shop', 'schemas', 'shop', 'tables', 'orders'],
);
const profile = tableFromDescription(
  [
    {
      id: 'columns',
      columns: ['Name', 'Type', 'Nullable', 'Key'],
      rows: [
        ['user_id', { $t: 'text', v: 'int' }, 'NO', 'PRI'],
        ['bio', 'text', 'YES', null],
      ],
    },
    {
      id: 'foreign-keys',
      columns: ['Name', 'Columns', 'Referenced schema', 'Referenced table', 'Referenced columns'],
      rows: [['fk', 'user_id', '', 'USERS', 'id']],
    },
  ],
  'profile',
  'shop',
  ['shop', 'tables', 'profile'],
);
const model = erdModel([users, orders, profile]);
const view = { detail: 'all' as const, types: true };

function overlap(a: ErdBox, b: ErdBox) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('the model of a diagram', () => {
  it('reads entities and their keys from the structure and from a description', () => {
    expect(
      orders.entity.columns.map((column) => [column.name, column.primary, column.foreign]),
    ).toEqual([
      ['id', true, false],
      ['user_id', false, true],
      ['parent', false, true],
    ]);
    expect(profile.entity.columns[0]).toEqual({
      name: 'user_id',
      type: 'int',
      nullable: false,
      primary: true,
      foreign: true,
    });
    expect(profile.entity.columns[1].nullable).toBe(true);
    expect(tableFromDescription([], 't', undefined, ['t']).entity).toEqual({
      key: 't',
      name: 't',
      path: ['t'],
      columns: [],
    });
  });

  it('relates the tables it holds, with their cardinality, and leaves out keys to others', () => {
    expect(
      model.relations.map((relation) => [
        relation.from,
        relation.to,
        relation.many,
        relation.optional,
        relation.identifying,
      ]),
    ).toEqual([
      ['shop.orders', 'shop.users', true, true, false],
      ['shop.orders', 'shop.orders', true, true, false],
      ['shop.profile', 'shop.users', false, false, true],
    ]);
    expect(model.relations[0].name).toBe('orders_user');
    expect(model.relations[1].name).toBe('orders → orders');
  });

  it('shows every column, the keys only, or none', () => {
    expect(shownColumns(users.entity, 'keys').map((column) => column.name)).toEqual(['id']);
    expect(shownColumns(users.entity, 'none')).toEqual([]);
    expect(entitySize(users.entity, { detail: 'none', types: false }).height).toBe(28);
    expect(entitySize(users.entity, view).width).toBeGreaterThanOrEqual(120);
  });
});

describe('the layout of a diagram', () => {
  it('puts the referenced tables left of the tables that reference them, without overlaps', () => {
    const boxes = erdLayout(model, view);
    expect(boxes['shop.users'].x).toBeLessThan(boxes['shop.orders'].x);
    expect(boxes['shop.users'].x).toBeLessThan(boxes['shop.profile'].x);
    const all = Object.values(boxes);
    for (const [at, box] of all.entries())
      for (const other of all.slice(at + 1)) expect(overlap(box, other)).toBe(false);
    expect(erdLayout(model, view)).toEqual(boxes);
  });

  it('lays out a grid by name, keeps the places moved, and bounds them', () => {
    const grid = erdLayout(model, view, 'grid');
    expect(Object.keys(grid)).toHaveLength(3);
    const scene = erdScene({
      model,
      view,
      notation: 'idef1x',
      auto: grid,
      positions: { 'shop.users': { x: 500, y: 40 } },
    });
    const placed = Object.fromEntries(scene.entities.map((entity) => [entity.key, entity.box]));
    expect(placed['shop.users']).toMatchObject({ x: 500, y: 40 });
    expect(placed['shop.orders']).toMatchObject({ x: grid['shop.orders'].x });
    const bounds = erdBounds(Object.values(placed));
    for (const box of Object.values(placed)) {
      expect(bounds.x).toBeLessThan(box.x);
      expect(bounds.x + bounds.width).toBeGreaterThan(box.x + box.width);
    }
    expect(erdBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('lays out 200 related tables in less than a second, without overlaps', () => {
    const tables = Array.from({ length: 200 }, (_, at) =>
      tableFromModel(
        readTable({
          name: `t${at}`,
          columns: [
            { name: 'id', typeName: 'int', nullable: false },
            { name: 'ref', typeName: 'int', nullable: true },
          ],
          primaryKey: { columns: ['id'] },
          foreignKeys:
            at % 7
              ? [
                  {
                    columns: ['ref'],
                    referencedTable: `t${Math.floor(at / 3)}`,
                    referencedColumns: ['id'],
                  },
                ]
              : [],
        }),
        [`t${at}`],
      ),
    );
    const big: ErdModel = erdModel(tables);
    const started = performance.now();
    const boxes = Object.values(erdLayout(big, view));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(boxes).toHaveLength(200);
    const sorted = [...boxes].sort((a, b) => a.x - b.x || a.y - b.y);
    for (const [at, box] of sorted.entries())
      for (const other of sorted.slice(at + 1, at + 40)) expect(overlap(box, other)).toBe(false);
  });
});

describe('the lines of the relations', () => {
  const boxes = erdLayout(model, view);
  const line = (index: number, notation: 'idef1x' | 'crowsfoot' | 'uml', detail = view) => {
    const relation = model.relations[index];
    const entity = (key: string) => model.entities.find((each) => each.key === key)!;
    return relationLine(
      relation,
      { from: entity(relation.from), to: entity(relation.to) },
      { from: boxes[relation.from], to: boxes[relation.to] },
      detail,
      notation,
    );
  };

  it('draws IDEF1X dashed for a key that does not identify, with a dot and a diamond', () => {
    const drawn = line(0, 'idef1x');
    expect(drawn.dashed).toBe(true);
    expect(drawn.marks.map((mark) => mark.filled)).toEqual([true, false]);
    expect(line(2, 'idef1x').dashed).toBe(false);
  });

  it("draws the crow's foot, its bars and circles, and UML multiplicities", () => {
    expect(line(0, 'crowsfoot').marks).toHaveLength(4);
    expect(line(2, 'crowsfoot').marks).toHaveLength(4);
    expect(line(0, 'uml').labels.map((label) => label.text)).toEqual(['*', '0..1']);
    expect(line(2, 'uml').labels.map((label) => label.text)).toEqual(['1', '1']);
  });

  it('loops a table that references itself, and stacks lines of boxes one above another', () => {
    expect(line(1, 'idef1x').d).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+ H [\d.]+$/);
    const stacked = relationLine(
      model.relations[0],
      { from: orders.entity, to: users.entity },
      {
        from: { x: 0, y: 200, width: 150, height: 60 },
        to: { x: 10, y: 0, width: 150, height: 60 },
      },
      { detail: 'none', types: false },
      'crowsfoot',
    );
    expect(stacked.d).toContain('V');
  });
});
