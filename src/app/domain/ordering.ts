/** Orders the person gives to lists by dragging their elements. */

/**
 * Elements in a stored order of ids. Those not in it, such as a collection created or imported
 * since, go first in their own order, as new collections do in Postman.
 */
export function ordered<T extends { id: string }>(list: readonly T[], order: readonly string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  const unlisted = list.filter((value) => !rank.has(value.id));
  const listed = list
    .filter((value) => rank.has(value.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...unlisted, ...listed];
}

/**
 * Moves an element of a list to a position counted before the move, so moving it just
 * after itself changes nothing. Returns a copy.
 */
export function moveWithin<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  const at = Math.min(Math.max(from < to ? to - 1 : to, 0), next.length);
  next.splice(at, 0, moved);
  return next;
}
