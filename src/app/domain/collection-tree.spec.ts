import {
  addFolder,
  folders,
  itemAt,
  moveInto,
  pathOf,
  removeItem,
  renameItem,
  reorderItem,
  withIds,
} from './collection-tree';
import { Collection } from './models';

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
