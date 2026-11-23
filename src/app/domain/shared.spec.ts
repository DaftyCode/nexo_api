import { CollectionItem } from './models';
import { isSharedFile, itemAt, pathOf, sharedFileName, sharedPath } from './shared';

describe('the collections shared by the team', () => {
  it('names the file of a collection and keeps to its extension', () => {
    expect(sharedFileName('Shop: API / v2?')).toBe('Shop API  v2.nexo-collection');
    expect(sharedFileName(' \u0001 ')).toBe('Collection.nexo-collection');
    expect(isSharedFile('D:/Drive/Shop.NEXO-COLLECTION ')).toBe(true);
    expect(isSharedFile('D:/Drive/notes.txt')).toBe(false);
    expect(sharedPath(' D:/Drive/Shop ')).toBe('D:/Drive/Shop.nexo-collection');
    expect(sharedPath('D:/Drive/Shop.nexo-collection')).toBe('D:/Drive/Shop.nexo-collection');
    expect(sharedPath('  ')).toBe('');
  });

  it('finds an item by its place and its place by its id', () => {
    const items: CollectionItem[] = [
      { id: 'a', name: 'a', request: {} },
      { id: 'f', name: 'f', item: [{ id: 'b', name: 'b', request: {} }] },
    ];
    expect(itemAt(items, [1, 0])?.id).toBe('b');
    expect(itemAt(items, [])).toBeUndefined();
    expect(itemAt(items, [5, 0])).toBeUndefined();
    expect(pathOf(items, 'b')).toEqual([1, 0]);
    expect(pathOf(items, 'a')).toEqual([0]);
    expect(pathOf(items, 'none')).toBeUndefined();
    expect(pathOf(undefined, 'a')).toBeUndefined();
  });
});
