import { AuthDraft, writeAuth } from './auth';
import { Collection, CollectionItem } from './models';

/** Changes to the folder and request tree of a collection. Every function returns a copy. */

function siblings(collection: Collection, path: readonly number[]): CollectionItem[] {
  let list = collection.item;
  for (const index of path.slice(0, -1)) {
    const folder = list[index];
    if (!folder?.item) throw new Error('Item not found');
    list = folder.item;
  }
  return list;
}
export function itemAt(
  collection: Collection,
  path: readonly number[],
): CollectionItem | undefined {
  let list = collection.item;
  let item: CollectionItem | undefined;
  for (const index of path) {
    item = list?.[index];
    if (!item) return undefined;
    list = item.item ?? [];
  }
  return item;
}
/** Gives an identifier to every item without one, so items can be followed across moves. */
export function withIds(collection: Collection, id: () => string): Collection {
  const next = structuredClone(collection);
  const visit = (items: CollectionItem[]) => {
    for (const item of items) {
      item.id ??= id();
      if (item.item) visit(item.item);
    }
  };
  visit(next.item);
  return next;
}
export function pathOf(collection: Collection, id: string): number[] | undefined {
  const search = (items: CollectionItem[], prefix: number[]): number[] | undefined => {
    for (const [index, item] of items.entries()) {
      if (item.id === id) return [...prefix, index];
      const found = item.item && search(item.item, [...prefix, index]);
      if (found) return found;
    }
    return undefined;
  };
  return search(collection.item, []);
}
export function addFolder(
  collection: Collection,
  parent: readonly number[],
  name: string,
  id: string,
): Collection {
  if (!name.trim()) throw new Error('A name is required');
  const next = structuredClone(collection);
  const folder = parent.length ? itemAt(next, parent) : undefined;
  if (parent.length && !folder?.item) throw new Error('Choose a folder');
  (folder?.item ?? next.item).push({ id, name: name.trim(), item: [] });
  return next;
}
export function renameItem(collection: Collection, path: readonly number[], name: string) {
  if (!name.trim()) throw new Error('A name is required');
  const next = structuredClone(collection);
  const item = itemAt(next, path);
  if (!item) throw new Error('Item not found');
  item.name = name.trim();
  return next;
}
export function removeItem(collection: Collection, path: readonly number[]) {
  const next = structuredClone(collection);
  const list = siblings(next, path);
  if (!list[path.at(-1)!]) throw new Error('Item not found');
  list.splice(path.at(-1)!, 1);
  return next;
}
/** Moves an item up (-1) or down (+1) among its siblings. */
export function reorderItem(collection: Collection, path: readonly number[], offset: -1 | 1) {
  const next = structuredClone(collection);
  const list = siblings(next, path);
  const from = path.at(-1)!;
  const to = from + offset;
  if (!list[from] || to < 0 || to >= list.length) return next;
  [list[from], list[to]] = [list[to], list[from]];
  return next;
}
/** Whether `path` is `folder` itself or something inside it. */
export function isWithin(path: readonly number[], folder: readonly number[]) {
  return path.length >= folder.length && folder.every((index, i) => path[i] === index);
}
/** Moves an item into a folder (`[]` is the collection root), at the end. */
export function moveInto(
  collection: Collection,
  path: readonly number[],
  folder: readonly number[],
) {
  return moveTo(collection, path, folder, Number.POSITIVE_INFINITY);
}
/**
 * Moves an item to a position of a folder (`[]` is the collection root). `index` counts the
 * folder's items before the move, so dropping just after the item itself changes nothing.
 */
export function moveTo(
  collection: Collection,
  path: readonly number[],
  folder: readonly number[],
  index: number,
) {
  if (isWithin(folder, path)) throw new Error('A folder cannot be moved into itself');
  const next = structuredClone(collection);
  const item = itemAt(next, path);
  const target = folder.length ? itemAt(next, folder) : undefined;
  if (!item || (folder.length && !target?.item)) throw new Error('Item not found');
  // The lists are found before removing: removing first would shift the folder path.
  const destination = target?.item ?? next.item;
  const source = siblings(next, path);
  const from = path.at(-1)!;
  source.splice(from, 1);
  let at = Math.min(Math.max(index, 0), destination.length + (source === destination ? 1 : 0));
  if (source === destination && from < at) at -= 1;
  destination.splice(Math.min(at, destination.length), 0, item);
  return next;
}
/** Where a drop puts an item: before or after another one, or inside a folder at its end. */
export type DropPosition = 'before' | 'after' | 'inside';
export function dropPlace(
  over: readonly number[],
  position: DropPosition,
): { folder: number[]; index: number } {
  if (position === 'inside') return { folder: [...over], index: Number.POSITIVE_INFINITY };
  const last = over.at(-1) ?? 0;
  return { folder: over.slice(0, -1), index: position === 'before' ? last : last + 1 };
}
/** Whether moving an item there leaves it where it is. */
export function staysInPlace(path: readonly number[], folder: readonly number[], index: number) {
  const parent = path.slice(0, -1);
  const from = path.at(-1)!;
  return (
    parent.length === folder.length &&
    parent.every((value, i) => folder[i] === value) &&
    (index === from || index === from + 1)
  );
}
/**
 * Stores an authorization on the collection (`[]`), a folder or a request, and nothing else,
 * such as a token just obtained. An inherited authorization removes the stored one.
 */
export function withStoredAuth(
  collection: Collection,
  path: readonly number[],
  auth: AuthDraft,
): Collection {
  const next = structuredClone(collection);
  const stored = writeAuth(auth);
  const place = (holder: Record<string, unknown>) => {
    if (stored) holder['auth'] = stored;
    else delete holder['auth'];
  };
  if (!path.length) {
    place(next);
    return next;
  }
  const item = itemAt(next, path);
  if (!item) throw new Error('Item not found');
  if (item.item) {
    place(item);
  } else {
    const request: Record<string, unknown> =
      typeof item.request === 'object' && item.request ? item.request : { url: item.request ?? '' };
    place(request);
    item.request = request;
  }
  return next;
}
/** Folders of a collection, with their paths, for "move to" choices. */
export function folders(collection: Collection): { name: string; path: number[] }[] {
  const result: { name: string; path: number[] }[] = [];
  const visit = (items: CollectionItem[], prefix: number[], names: string[]) =>
    items.forEach((item, index) => {
      if (!item.item) return;
      const path = [...prefix, index];
      result.push({ name: [...names, item.name].join(' / '), path });
      visit(item.item, path, [...names, item.name]);
    });
  visit(collection.item, [], []);
  return result;
}
