import { describe, expect, it } from 'vitest';
import {
  diagramTable,
  emptyDiagram,
  layoutKey,
  readDiagram,
  readLayouts,
  siblingTable,
} from './erd-document';

describe('saved diagrams', () => {
  it('reads a stored diagram defensively', () => {
    expect(readDiagram(null)).toEqual(emptyDiagram(''));
    expect(
      readDiagram({
        connectionId: 'c1',
        notation: 'crowsfoot',
        detail: 'keys',
        types: false,
        entities: [
          {
            path: ['shop', 'tables', 'orders'],
            name: 'orders',
            schema: 'shop',
            x: 10,
            y: 20,
            color: 'info',
            hidden: true,
          },
          { path: ['t'], name: 't', x: 'no', color: 'pink', schema: '' },
          { path: [], name: 'pathless' },
          { path: ['x'] },
          'nothing',
        ],
        notes: [{ id: 'n1', text: 'hi', x: 1, y: 2 }, { id: 'n2', text: 'no place' }, null],
      }),
    ).toEqual({
      connectionId: 'c1',
      notation: 'crowsfoot',
      detail: 'keys',
      types: false,
      entities: [
        {
          path: ['shop', 'tables', 'orders'],
          name: 'orders',
          schema: 'shop',
          x: 10,
          y: 20,
          color: 'info',
          hidden: true,
        },
        { path: ['t'], name: 't' },
      ],
      notes: [{ id: 'n1', text: 'hi', x: 1, y: 2 }],
    });
    expect(readDiagram({ notation: 'chen', detail: 'some' })).toMatchObject({
      notation: 'idef1x',
      detail: 'all',
      types: true,
    });
  });

  it('finds the table of a path, and the tables beside it in its schema or in another', () => {
    const orders = diagramTable(['shop', 'schemas', 'public', 'tables', 'orders']);
    expect(orders).toEqual({
      path: ['shop', 'schemas', 'public', 'tables', 'orders'],
      name: 'orders',
      schema: 'public',
    });
    expect(diagramTable(['tables', 'notes'])).toEqual({ path: ['tables', 'notes'], name: 'notes' });
    expect(siblingTable(orders, 'users')).toMatchObject({
      path: ['shop', 'schemas', 'public', 'tables', 'users'],
      schema: 'public',
    });
    expect(siblingTable(orders, 'log', 'audit')).toEqual({
      path: ['shop', 'schemas', 'audit', 'tables', 'log'],
      name: 'log',
      schema: 'audit',
    });
    expect(siblingTable(diagramTable(['tables', 'notes']), 'users')).toEqual({
      path: ['tables', 'users'],
      name: 'users',
    });
  });

  it('reads the layouts of the automatic diagrams kept in the session', () => {
    expect(
      readLayouts({
        [layoutKey('c1', ['shop'])]: {
          positions: { 'shop.orders': { x: 1, y: 2 }, bad: { x: 'a' } },
          hidden: ['shop.log', 3],
          colors: { 'shop.orders': 'success', other: 'pink' },
          notation: 'uml',
          detail: 'none',
          types: false,
        },
        empty: null,
      }),
    ).toEqual({
      'c1\nshop': {
        positions: { 'shop.orders': { x: 1, y: 2 } },
        hidden: ['shop.log'],
        colors: { 'shop.orders': 'success' },
        notation: 'uml',
        detail: 'none',
        types: false,
      },
      empty: { positions: {} },
    });
    expect(readLayouts('nothing')).toEqual({});
  });
});
