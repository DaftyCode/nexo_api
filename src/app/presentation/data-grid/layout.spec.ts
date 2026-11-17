import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { GridView, emptyView } from '../../domain/db/grid/view';
import { ResultColumn } from '../../domain/db/results';
import { GridLayout } from './layout';

const columns: ResultColumn[] = ['a', 'b', 'c'].map((name) => ({
  name,
  typeName: 'text',
  kind: 'text',
}));

function fixture(view: Partial<GridView> = {}) {
  const shown = signal<GridView>({ ...emptyView(), ...view });
  const layout = new GridLayout({
    columns: () => columns,
    rows: () => Array.from({ length: 100 }, (_, at) => [String(at), 'x', 'y']),
    view: () => shown(),
    filter: () => '',
  });
  return { layout, shown };
}
/** A scrolling element with the sizes the layout reads. */
function element(size: { height: number; width: number }) {
  const box = document.createElement('div');
  Object.defineProperty(box, 'clientHeight', { value: size.height });
  Object.defineProperty(box, 'clientWidth', { value: size.width });
  return box;
}

describe('the layout of a grid', () => {
  it('fills the grid with the columns not sized, and keeps the sized ones', () => {
    const { layout } = fixture({ widths: { 1: 200 } });
    layout.scroll.set({ top: 0, left: 0, height: 300, width: 2000 });
    expect(layout.widthOf(1)).toBe(200);
    expect(layout.widthOf(0)).toBeGreaterThan(200);
    const narrow = fixture();
    narrow.layout.scroll.set({ top: 0, left: 0, height: 300, width: 100 });
    expect(narrow.layout.widthOf(0)).toBe(narrow.layout.fitted(columns[0], 0));
    expect(narrow.layout.widthOf(9)).toBe(120);
  });

  it('measures its rows and header, and reveals a cell up, down, left and right', () => {
    const { layout } = fixture({ pinned: [0] });
    const box = element({ height: 200, width: 200 });
    box.innerHTML =
      '<div class="grid-row grid-header"></div><div class="grid-row"></div><div class="grid-cell"></div>';
    for (const row of box.querySelectorAll<HTMLElement>('.grid-row'))
      Object.defineProperty(row, 'offsetHeight', {
        value: row.classList.contains('grid-header') ? 30 : 20,
      });
    layout.measure(box);
    expect(layout.rowHeight()).toBe(20);
    expect(layout.headerHeight()).toBe(30);
    layout.reveal(box, { row: 50, column: 2 });
    expect(box.scrollTop).toBe(50 * 20 + 20 - 170);
    expect(box.scrollLeft).toBeGreaterThan(0);
    layout.reveal(box, { row: 0, column: 1 });
    expect(box.scrollTop).toBe(0);
    expect(box.scrollLeft).toBe(0);
    layout.reveal(box, { row: 0, column: 0 });
    expect(layout.page()).toBeGreaterThanOrEqual(1);
  });
});
