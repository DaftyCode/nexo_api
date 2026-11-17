import { describe, expect, it } from 'vitest';
import { tableFromModel } from '../../domain/db/erd';
import { DiagramLayout } from '../../domain/db/erd-document';
import { readTable } from '../../domain/db/structure';
import { DiagramDraft, ZOOM, diagramSource, noteKey } from './diagram-draft';

const table = (name: string, keys: string[] = []) =>
  tableFromModel(
    readTable({
      schema: 'shop',
      name,
      columns: [
        { name: 'id', typeName: 'int', nullable: false },
        ...keys.map((key) => ({ name: `${key}_id`, typeName: 'int', nullable: true })),
      ],
      primaryKey: { columns: ['id'] },
      foreignKeys: keys.map((key) => ({
        columns: [`${key}_id`],
        referencedTable: key,
        referencedColumns: ['id'],
      })),
    }),
    ['shop', 'schemas', 'shop', 'tables', name],
  );

function draft(keep?: (layout: DiagramLayout) => void) {
  const made = new DiagramDraft({ kind: 'node', connection: 'c1', path: ['shop'] }, keep);
  made.tables.set([table('users'), table('orders', ['users']), table('lines', ['orders'])]);
  return made;
}

describe('a diagram open in a tab', () => {
  it('knows what it shows from its tab', () => {
    expect(
      diagramSource({ id: 't', kind: 'diagram', connection: 'c', title: 'd', diagram: 'd1' }),
    ).toEqual({ kind: 'saved', connection: 'c', id: 'd1' });
    expect(
      diagramSource({ id: 't', kind: 'object', connection: 'c', title: 'o', path: ['o'] }),
    ).toEqual({ kind: 'table', connection: 'c', path: ['o'] });
    expect(diagramSource({ id: 't', kind: 'diagram', connection: 'c', title: 's' })).toEqual({
      kind: 'node',
      connection: 'c',
      path: [],
    });
  });

  it('keeps the layout of an automatic diagram as it changes, and takes it back', () => {
    const kept: DiagramLayout[] = [];
    const diagram = draft((layout) => kept.push(layout));
    diagram.setNotation('uml');
    diagram.setDetail('keys');
    diagram.setTypes(false);
    expect(kept.at(-1)).toEqual({ positions: {}, notation: 'uml', detail: 'keys', types: false });
    diagram.select('shop.users');
    diagram.paint('info');
    diagram.removeSelected();
    expect(kept.at(-1)).toMatchObject({ hidden: ['shop.users'], colors: { 'shop.users': 'info' } });
    expect(diagram.dirty()).toBe(false);

    const again = draft();
    again.restore(undefined);
    again.restore(kept.at(-1));
    expect(again.notation()).toBe('uml');
    expect(again.hiddenEntities().map((entity) => entity.key)).toEqual(['shop.users']);
    expect(again.scene().entities.map((entity) => entity.key)).toEqual([
      'shop.orders',
      'shop.lines',
    ]);
    expect(again.scene().lines).toHaveLength(1);
    again.restore({ positions: {} });
    expect(again.hidden()).toEqual([]);
    again.changed();
    expect(again.dirty()).toBe(true);
  });

  it('selects, moves and lays out its entities again', () => {
    const diagram = draft();
    const before = diagram.scene().entities.find((entity) => entity.key === 'shop.orders')!.box;
    diagram.select('shop.orders');
    diagram.select('shop.users', true);
    diagram.select('shop.users', true);
    expect([...diagram.selected()]).toEqual(['shop.orders']);
    diagram.moveBy(diagram.selected(), 15, -5);
    const after = diagram.scene().entities.find((entity) => entity.key === 'shop.orders')!.box;
    expect([after.x - before.x, after.y - before.y]).toEqual([15, -5]);

    diagram.arrange('grid');
    expect(Object.keys(diagram.positions())).toHaveLength(3);
    diagram.selectAll();
    expect(diagram.selected().size).toBe(3);
    diagram.paint(undefined);
    expect(diagram.colors()).toEqual({});
  });

  it('finds tables by name, and shows the hidden ones again one by one or all', () => {
    const diagram = draft();
    diagram.search.set(' ORD ');
    expect([...diagram.found()]).toEqual(['shop.orders']);
    diagram.search.set('');
    expect(diagram.found().size).toBe(0);
    diagram.hidden.set(['shop.users', 'shop.lines']);
    diagram.show('shop.users');
    expect(diagram.hidden()).toEqual(['shop.lines']);
    diagram.show();
    expect(diagram.hidden()).toEqual([]);
    diagram.selected.set(new Set());
    diagram.removeSelected();
    expect(diagram.dirty()).toBe(true);
  });

  it('writes, moves and deletes notes', () => {
    const diagram = draft();
    diagram.addNote('n1', { x: 10, y: 20 });
    expect([...diagram.selected()]).toEqual([noteKey('n1')]);
    diagram.writeNote('n1', 'Billing\nlives here');
    diagram.writeNote('other', 'nothing');
    diagram.moveBy([noteKey('n1')], 5, 5);
    expect(diagram.scene().notes[0]).toMatchObject({ text: 'Billing\nlives here', x: 15, y: 25 });
    diagram.moveBy(['shop.users'], 1, 1);
    expect(diagram.notes()[0].x).toBe(15);
    diagram.removeSelected();
    expect(diagram.notes()).toEqual([]);
  });

  it('zooms around a point within its limits, fits the diagram and centers a point', () => {
    const diagram = draft();
    diagram.zoomAt(2, { x: 100, y: 100 });
    expect(diagram.zoom()).toBe(2);
    expect(diagram.pan()).toEqual({ x: -100, y: -100 });
    diagram.zoomAt(100, { x: 0, y: 0 });
    expect(diagram.zoom()).toBe(ZOOM.max);
    diagram.zoomAt(0.0001, { x: 0, y: 0 });
    expect(diagram.zoom()).toBe(ZOOM.min);

    diagram.fit(10_000, 10_000);
    expect(diagram.zoom()).toBe(1);
    diagram.fit(100, 100);
    expect(diagram.zoom()).toBeLessThan(1);
    diagram.centerOn({ x: 50, y: 50 }, 200, 100);
    expect(diagram.pan()).toEqual({ x: 100 - 50 * diagram.zoom(), y: 50 - 50 * diagram.zoom() });

    const empty = new DiagramDraft({ kind: 'saved', connection: 'c1', id: 'd1' });
    empty.fit(100, 100);
    expect(empty.zoom()).toBe(1);
  });
});
