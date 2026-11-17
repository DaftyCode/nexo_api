/** Where a popup opens: its left side, and its top or (near the foot of the window) its bottom. */
export interface PopupPlace {
  x: number;
  y?: number;
  bottom?: number;
  /** The tallest it may be to stay inside the window; what does not fit scrolls. */
  maxHeight?: number;
}

/** What a popup keeps clear of the window's edges, in pixels. */
const MARGIN = 8;
/** The tallest a popup gets, as a share of the window. */
const TALLEST = 0.7;

/**
 * Places a popup by the element that opened it: under it, or over it when there is more room
 * above, never past the window's right side, and never taller than the room it has.
 */
export function placeBy(element: Element, width = 260): PopupPlace {
  const box = element.getBoundingClientRect();
  return place(box.left, box.top - 4, box.bottom + 4, width);
}

/** Places a popup at a point, such as where the mouse was right-clicked. */
export function placeAt(x: number, y: number, width = 260): PopupPlace {
  return place(x, y, y, width);
}

function place(left: number, above: number, below: number, width: number): PopupPlace {
  const view = { width: globalThis.innerWidth || 1024, height: globalThis.innerHeight || 768 };
  const x = Math.max(4, Math.min(left, view.width - width));
  const room = { above: above - MARGIN, below: view.height - below - MARGIN };
  const tallest = (space: number) => Math.round(Math.min(view.height * TALLEST, space));
  return room.below >= room.above
    ? { x, y: below, maxHeight: tallest(room.below) }
    : { x, bottom: view.height - above, maxHeight: tallest(room.above) };
}
