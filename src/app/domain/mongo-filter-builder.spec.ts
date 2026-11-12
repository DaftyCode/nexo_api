import {
  BlockError,
  Group,
  blocksFilter,
  emptyCondition,
  filterBlocks,
} from './mongo-filter-builder';
import { shellToExtendedJson } from './mongo-query';

const same = (text: string) => shellToExtendedJson(blocksFilter(filterBlocks(text)!));

describe('Filter blocks', () => {
  it('shows a filter as blocks and writes it back the same', () => {
    for (const filter of [
      "{ status: 'A' }",
      "{ status: 'A', qty: { $gt: 5, $lte: 9 } }",
      "{ $or: [{ status: 'A' }, { qty: { $lt: 30 } }] }",
      '{ a: 1, $or: [{ b: { $in: [1, 2] } }, { c: { $exists: false } }] }',
      "{ at: { $gte: ISODate('2024-01-02T00:00:00Z') }, name: /^ab/i }",
    ])
      expect(same(filter)).toEqual(shellToExtendedJson(filter));
    expect(filterBlocks('')).toEqual({ kind: 'group', join: '$and', items: [] });
    // An explicit $and of different fields is written as one document, which means the same.
    expect(same('{ $and: [{ a: 1 }, { $or: [{ b: 1 }, { c: 2 }] }] }')).toEqual({
      a: 1,
      $or: [{ b: 1 }, { c: 2 }],
    });
  });

  it('reads conditions with their operators', () => {
    expect(filterBlocks("{ qty: { $gt: 5 }, tags: { $in: ['a'] } }")).toEqual({
      kind: 'group',
      join: '$and',
      items: [
        { kind: 'condition', field: 'qty', operator: '$gt', value: '5' },
        { kind: 'condition', field: 'tags', operator: '$in', value: '[\n  "a"\n]' },
      ],
    });
  });

  it('refuses what the blocks cannot show', () => {
    for (const filter of [
      '{ $expr: { $gt: ["$a", "$b"] } }',
      '{ a: { $elemMatch: { b: 1 } } }',
      '{ $nor: [{ a: 1 }] }',
      '{ a: ',
      '[1]',
    ])
      expect(filterBlocks(filter), filter).toBeUndefined();
  });

  it('writes blocks as people write filters, and says which value cannot be read', () => {
    const group: Group = {
      kind: 'group',
      join: '$and',
      items: [
        { kind: 'condition', field: 'a', operator: '$gt', value: '1' },
        { kind: 'condition', field: 'a', operator: '$lt', value: '9' },
        emptyCondition(),
      ],
    };
    expect(shellToExtendedJson(blocksFilter(group))).toEqual({ a: { $gt: 1, $lt: 9 } });
    const twice: Group = { ...group, items: [group.items[0], group.items[0]] };
    expect(shellToExtendedJson(blocksFilter(twice))).toEqual({
      $and: [{ a: { $gt: 1 } }, { a: { $gt: 1 } }],
    });
    expect(blocksFilter({ kind: 'group', join: '$or', items: [] })).toBe('');
    const bad = { kind: 'condition', field: 'a', operator: '$in', value: '5' } as const;
    expect(() => blocksFilter({ kind: 'group', join: '$and', items: [bad] })).toThrow(BlockError);
    const unreadable = { ...bad, operator: '$eq', value: '{a: ' } as const;
    try {
      blocksFilter({ kind: 'group', join: '$and', items: [unreadable] });
    } catch (error) {
      expect((error as BlockError).key).toBe('mongo.blocks.value');
    }
  });
});
