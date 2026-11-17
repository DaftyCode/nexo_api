import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { GridView, emptyView } from '../../domain/db/grid/view';
import { COLUMN, GridColumns } from './columns';
import { GridPointer } from './pointer';

function fixture() {
  const view = signal<GridView>(emptyView());
  const columns = new GridColumns(
    view as never,
    () => 3,
    (column) => 100 + column,
  );
  return { view, columns };
}

describe('the columns of a grid', () => {
  it('resizes within the limits, fits and sorts in turn', () => {
    const { view, columns } = fixture();
    columns.resize(0, 10);
    columns.resize(1, 5000);
    columns.fit(2);
    expect(view().widths).toEqual({ 0: COLUMN.min, 1: COLUMN.max, 2: 102 });
    columns.sort(1);
    expect(view().sort).toEqual({ column: 1, descending: false });
    columns.sort(1);
    expect(view().sort).toEqual({ column: 1, descending: true });
  });

  it('runs each entry of the column menu, and no other', () => {
    const { view, columns } = fixture();
    const shown = [0, 1, 2];
    expect(columns.run('descending', 1, shown, 100)).toBe(true);
    expect(view().sort).toEqual({ column: 1, descending: true });
    columns.run('ascending', 1, shown, 100);
    expect(view().sort?.descending).toBe(false);
    columns.run('unsorted', 1, shown, 100);
    expect(view().sort).toBeUndefined();
    columns.run('wider', 0, shown, 100);
    expect(view().widths[0]).toBe(132);
    columns.run('narrower', 0, shown, 100);
    expect(view().widths[0]).toBe(68);
    columns.run('fit', 0, shown, 100);
    expect(view().widths[0]).toBe(100);
    columns.run('hide', 2, shown, 100);
    columns.run('hide', 2, shown, 100);
    expect(view().hidden).toEqual([2]);
    columns.show(2);
    columns.hide(1);
    columns.run('show-all', 0, shown, 100);
    expect(view().hidden).toEqual([]);
    columns.run('pin', 2, shown, 100);
    expect(view().pinned).toEqual([2]);
    columns.run('pin', 2, shown, 100);
    expect(view().pinned).toEqual([]);
    columns.run('right', 0, shown, 100);
    expect(view().order).toEqual([1, 0, 2]);
    columns.run('left', 0, [1, 0, 2], 100);
    expect(view().order).toEqual([0, 1, 2]);
    columns.shift(2, [0, 1, 2], 1);
    columns.move(1, 1, true);
    expect(view().order).toEqual([0, 1, 2]);
    expect(columns.run('nothing', 0, shown, 100)).toBe(false);
  });
});

describe('the pointer on the headers of a grid', () => {
  const pointer = (type: string, clientX: number, target?: HTMLElement) => {
    const event = new MouseEvent(type, { clientX, cancelable: true }) as PointerEvent;
    if (target) Object.defineProperty(event, 'target', { value: target });
    return event;
  };

  it('resizes a column by the edge of its header', () => {
    const { view, columns } = fixture();
    const edges = new GridPointer(columns, () => 100);
    edges.resizeMove(pointer('pointermove', 50));
    expect(view().widths).toEqual({});
    edges.resizeStart(pointer('pointerdown', 10, document.createElement('div')), 1);
    edges.resizeMove(pointer('pointermove', 60));
    expect(view().widths[1]).toBe(150);
    edges.resizeEnd();
    edges.resizeMove(pointer('pointermove', 500));
    expect(view().widths[1]).toBe(150);
  });

  it('moves a column dropped beside another, on the side it was dropped', () => {
    const { view, columns } = fixture();
    const drag = new GridPointer(columns, () => 100);
    const header = document.createElement('div');
    header.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    const over = (clientX: number) => {
      const event = new MouseEvent('dragover', { clientX, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'currentTarget', { value: header });
      return event;
    };
    drag.dragOver(over(80), 2);
    expect(drag.drop()).toBeUndefined();
    const transfer = { effectAllowed: '', setData: () => undefined };
    const start = new MouseEvent('dragstart') as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: transfer });
    drag.dragStart(start, 0, 'id');
    expect(transfer.effectAllowed).toBe('move');
    drag.dragOver(over(80), 2);
    drag.dragOver(over(80), 2);
    expect(drag.at(2)).toBe('after');
    expect(drag.at(1)).toBeNull();
    drag.dragOver(over(10), 2);
    expect(drag.at(2)).toBe('before');
    drag.dropOn(new MouseEvent('drop', { cancelable: true }) as DragEvent, 2);
    expect(view().order).toEqual([1, 0, 2]);
    expect(drag.dragging()).toBeUndefined();
    drag.dropOn(new MouseEvent('drop') as DragEvent, 2);
    drag.dragStart(new MouseEvent('dragstart') as DragEvent, 1, 'x');
    drag.dropOn(new MouseEvent('drop') as DragEvent, 2);
    expect(view().order).toEqual([1, 0, 2]);
  });
});
