import {
  addFolder,
  dropPlace,
  folders,
  isWithin,
  itemAt,
  moveBetween,
  moveInto,
  moveTo,
  staysInPlace,
  withStoredAuth,
  pathOf,
  removeItem,
  renameItem,
  reorderItem,
  withIds,
} from './collection-tree';
import { Collection } from './models';
import { emptyAuth } from './auth';

function collection(): Collection {
  return {
    info: { name: 'API', schema: 'x' },
    item: [
      { id: 'a', name: 'A', request: { method: 'GET', url: 'http://a' } },
      {
        id: 'f',
        name: 'Folder',
        item: [
          { id: 'b', name: 'B', request: { method: 'GET', url: 'http://b' } },
          { id: 'g', name: 'Inner', item: [] },
        ],
      },
      { name: 'C', request: { method: 'GET', url: 'http://c' } },
    ],
  };
}

describe('collection tree operations', () => {
  it('adds folders at the root or inside a folder', () => {
    const root = addFolder(collection(), [], ' New ', 'n1');
    expect(root.item.at(-1)).toEqual({ id: 'n1', name: 'New', item: [] });
    const nested = addFolder(collection(), [1], 'Sub', 'n2');
    expect(itemAt(nested, [1, 2])?.name).toBe('Sub');
    expect(() => addFolder(collection(), [0], 'X', 'n3')).toThrowError('Choose a folder');
    expect(() => addFolder(collection(), [], ' ', 'n4')).toThrowError('A name is required');
  });
  it('moves an item with everything inside it to a folder of another collection', () => {
    const other: Collection = {
      info: { name: 'Other', schema: 'x' },
      item: [{ id: 'o', name: 'Box', item: [{ id: 'z', name: 'Z', request: {} }] }],
    };
    const moved = moveBetween(collection(), [1], other, [0], 0);
    expect(moved.source.item.map((i) => i.id)).toEqual(['a', undefined]);
    expect(itemAt(moved.target, [0, 0])?.item?.map((i) => i.id)).toEqual(['b', 'g']);
    expect(itemAt(moved.target, [0, 1])?.id).toBe('z');
    expect(other.item[0].item).toHaveLength(1);
    const atRoot = moveBetween(collection(), [0], other, [], Number.POSITIVE_INFINITY);
    expect(atRoot.target.item.map((i) => i.id)).toEqual(['o', 'a']);
    expect(() => moveBetween(collection(), [0], other, [0, 0], 0)).toThrowError('Item not found');
  });
  it('renames and removes items without changing the original', () => {
    const original = collection();
    expect(itemAt(renameItem(original, [1, 0], 'Renamed'), [1, 0])?.name).toBe('Renamed');
    const removed = removeItem(original, [1, 0]);
    expect(itemAt(removed, [1])?.item?.map((i) => i.id)).toEqual(['g']);
    expect(itemAt(original, [1, 0])?.name).toBe('B');
  });
  it('reorders siblings and ignores moves past the ends', () => {
    expect(reorderItem(collection(), [0], 1).item.map((i) => i.name)).toEqual(['Folder', 'A', 'C']);
    expect(reorderItem(collection(), [0], -1).item.map((i) => i.name)).toEqual([
      'A',
      'Folder',
      'C',
    ]);
  });
  it('moves items between folders and never into themselves', () => {
    const moved = moveInto(collection(), [0], [1, 1]);
    expect(pathOf(moved, 'a')).toEqual([0, 1, 0]);
    const toRoot = moveInto(collection(), [1, 0], []);
    expect(pathOf(toRoot, 'b')).toEqual([3]);
    expect(() => moveInto(collection(), [1], [1, 1])).toThrowError(
      'A folder cannot be moved into itself',
    );
  });
  it('moves items to a position: before, after or inside, as a drop does', () => {
    const names = (c: Collection) => c.item.map((i) => i.name);
    // Reordering among siblings, counting positions before the move.
    expect(names(moveTo(collection(), [0], [], 3))).toEqual(['Folder', 'C', 'A']);
    expect(names(moveTo(collection(), [2], [], 0))).toEqual(['C', 'A', 'Folder']);
    expect(names(moveTo(collection(), [0], [], 1))).toEqual(['A', 'Folder', 'C']);
    expect(names(moveTo(collection(), [0], [], -4))).toEqual(['A', 'Folder', 'C']);
    // Into a folder at a position, out of a folder, and a whole folder with its items.
    expect(pathOf(moveTo(collection(), [2], [1], 1), 'b')).toEqual([1, 0]);
    expect(itemAt(moveTo(collection(), [2], [1], 1), [1, 1])?.name).toBe('C');
    expect(names(moveTo(collection(), [1, 0], [], 0))).toEqual(['B', 'A', 'Folder', 'C']);
    const folder = moveTo(collection(), [1], [], 0);
    expect(names(folder)).toEqual(['Folder', 'A', 'C']);
    expect(pathOf(folder, 'g')).toEqual([0, 1]);
    // A folder moved inside a later sibling folder, whose path shifts when it leaves.
    const nested = addFolder(collection(), [], 'Last', 'l');
    expect(pathOf(moveTo(nested, [1], [3], 0), 'b')).toEqual([2, 0, 0]);
    // Never into itself or one of its folders, and never to a request or a missing place.
    for (const folderPath of [[1], [1, 1], [1, 1, 0]])
      expect(() => moveTo(collection(), [1], folderPath, 0)).toThrowError(
        'A folder cannot be moved into itself',
      );
    expect(() => moveTo(collection(), [2], [0], 0)).toThrowError('Item not found');
    expect(() => moveTo(collection(), [9], [], 0)).toThrowError('Item not found');
    const original = collection();
    moveTo(original, [0], [1], 0);
    expect(names(original)).toEqual(['A', 'Folder', 'C']);
  });
  it('turns a drop into a place, and tells when nothing would change', () => {
    expect(dropPlace([1, 2], 'before')).toEqual({ folder: [1], index: 2 });
    expect(dropPlace([1, 2], 'after')).toEqual({ folder: [1], index: 3 });
    expect(dropPlace([1], 'inside')).toEqual({ folder: [1], index: Number.POSITIVE_INFINITY });
    expect(dropPlace([], 'inside').folder).toEqual([]);
    expect(staysInPlace([1, 2], [1], 2)).toBe(true);
    expect(staysInPlace([1, 2], [1], 3)).toBe(true);
    expect(staysInPlace([1, 2], [1], 4)).toBe(false);
    expect(staysInPlace([1, 2], [], 2)).toBe(false);
    expect(staysInPlace([0], [], 1)).toBe(true);
    expect(isWithin([1, 0], [1])).toBe(true);
    expect(isWithin([1], [1])).toBe(true);
    expect(isWithin([2], [1])).toBe(false);
    expect(isWithin([], [1])).toBe(false);
  });
  it('stores an authorization on the collection, a folder or a request, and nothing else', () => {
    const bearer = { ...emptyAuth('bearer'), token: '{{token}}' };
    const original = collection();
    const root = withStoredAuth(original, [], bearer);
    expect(root['auth']).toMatchObject({ type: 'bearer' });
    expect(root.item).toEqual(original.item);
    expect(itemAt(withStoredAuth(original, [1], bearer), [1])?.['auth']).toMatchObject({
      type: 'bearer',
    });
    const request = itemAt(withStoredAuth(original, [1, 0], bearer), [1, 0])?.request as Record<
      string,
      unknown
    >;
    expect(request).toMatchObject({ method: 'GET', url: 'http://b', auth: { type: 'bearer' } });
    // An inherited authorization removes the stored one.
    expect(withStoredAuth(root, [], emptyAuth('inherit'))).not.toHaveProperty('auth');
    // A request saved as a bare URL becomes an object.
    const bare = { ...original, item: [{ id: 'u', name: 'U', request: 'http://u' }] };
    expect(itemAt(withStoredAuth(bare, [0], bearer), [0])?.request).toMatchObject({
      url: 'http://u',
      auth: { type: 'bearer' },
    });
    expect(() => withStoredAuth(original, [9], bearer)).toThrowError('Item not found');
    expect(original).toEqual(collection());
  });
  it('assigns identifiers and lists folders for move choices', () => {
    let next = 0;
    const named = withIds(collection(), () => `id${++next}`);
    expect(named.item[2].id).toBe('id1');
    expect(folders(named)).toEqual([
      { name: 'Folder', path: [1] },
      { name: 'Folder / Inner', path: [1, 1] },
    ]);
  });
});
