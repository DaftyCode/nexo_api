import { roomyGrids } from './grid';

describe('roomy grids in tests', () => {
  it('measures grids as roomy only until it is undone', () => {
    const viewport = document.createElement('div');
    viewport.className = 'grid-viewport';
    const other = document.createElement('div');
    const restore = roomyGrids(400, 300);
    expect([viewport.clientWidth, viewport.clientHeight]).toEqual([400, 300]);
    expect(other.clientWidth).toBe(0);
    restore();
    // The later tests of the same worker measure grids as jsdom does again.
    expect([viewport.clientWidth, viewport.clientHeight]).toEqual([0, 0]);
    expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')).toBeUndefined();
  });
});
