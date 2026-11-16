/** Where a popup opens: its left side, and its top or (near the foot of the window) its bottom. */
export interface PopupPlace {
  x: number;
  y?: number;
  bottom?: number;
}

/**
 * Places a popup by the element that opened it: under it, or over it when the element is in
 * the lower part of the window, and never past the window's right side.
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
  return below > view.height * 0.6 ? { x, bottom: view.height - above } : { x, y: below };
}
