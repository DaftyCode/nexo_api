import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeAt, placeBy } from './popup-place';

describe('where a popup opens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens down with no more height than the room below, when there is more room below', () => {
    vi.stubGlobal('innerWidth', 1300);
    vi.stubGlobal('innerHeight', 1000);
    // A click a little above the middle: the menu opens down and scrolls inside the window.
    expect(placeAt(400, 430)).toEqual({ x: 400, y: 430, maxHeight: 562 });
    // Near the top, it is not taller than 70% of the window.
    expect(placeAt(400, 20)).toEqual({ x: 400, y: 20, maxHeight: 700 });
  });

  it('opens up when there is more room above, never past the right side', () => {
    vi.stubGlobal('innerWidth', 1300);
    vi.stubGlobal('innerHeight', 1000);
    expect(placeAt(1250, 580)).toEqual({ x: 1040, bottom: 420, maxHeight: 572 });
    expect(placeAt(-20, 990)).toEqual({ x: 4, bottom: 10, maxHeight: 700 });
  });

  it('places it by the element that opened it, under or over it', () => {
    vi.stubGlobal('innerWidth', 1300);
    vi.stubGlobal('innerHeight', 1000);
    const element = (top: number, bottom: number) =>
      ({ getBoundingClientRect: () => ({ left: 100, top, bottom }) }) as Element;
    expect(placeBy(element(100, 120))).toEqual({ x: 100, y: 124, maxHeight: 700 });
    expect(placeBy(element(900, 920))).toEqual({ x: 100, bottom: 104, maxHeight: 700 });
    vi.stubGlobal('innerWidth', 0);
    vi.stubGlobal('innerHeight', 0);
    expect(placeAt(10, 10, 100)).toEqual({ x: 10, y: 10, maxHeight: 538 });
  });
});
