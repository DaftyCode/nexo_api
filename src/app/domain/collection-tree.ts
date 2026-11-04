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
/** Moves an item into a folder (`[]` is the collection root), at the end. */
export function moveInto(
  collection: Collection,
  path: readonly number[],
  folder: readonly number[],
) {
  if (folder.length >= path.length && path.every((index, i) => folder[i] === index))
    throw new Error('A folder cannot be moved into itself');
  const next = structuredClone(collection);
  const item = itemAt(next, path);
  const target = folder.length ? itemAt(next, folder) : undefined;
  if (!item || (folder.length && !target?.item)) throw new Error('Item not found');
  // Insert first: removing first would shift the folder path.
  (target?.item ?? next.item).push(structuredClone(item));
  const source = siblings(next, path);
  source.splice(path.at(-1)!, 1);
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
