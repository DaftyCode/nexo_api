import { describe, expect, it } from 'vitest';
import { collectionNodes, databaseNodes } from './tree';

describe('MongoDB in the tree of the databases', () => {
  it('shows databases, the server own ones as system objects', () => {
    expect(
      databaseNodes([
        { name: 'shop', empty: false },
        { name: 'local', empty: false },
      ]),
    ).toEqual([
      { kind: 'database', name: 'shop', label: 'shop', hasChildren: true, actions: ['open'] },
      {
        kind: 'database',
        name: 'local',
        label: 'local',
        hasChildren: true,
        actions: ['open'],
        system: true,
      },
    ]);
  });

  it('shows each collection as its kind, with its source or bucket', () => {
    const nodes = collectionNodes([
      { name: 'orders', kind: 'collection', capped: false },
      { name: 'recent', kind: 'view', viewOn: 'orders', capped: false },
      { name: 'metrics', kind: 'timeseries', capped: false },
      { name: 'fs.files', kind: 'collection', gridfs: 'fs', capped: false },
      { name: 'system.views', kind: 'collection', capped: false },
    ]);
    expect(nodes.map((node) => [node.kind, node.detail ?? '', !!node.system])).toEqual([
      ['collection', '', false],
      ['view', '→ orders', false],
      ['timeseries', '', false],
      ['gridfs', 'fs', false],
      ['collection', '', true],
    ]);
    expect(nodes.every((node) => !node.hasChildren && node.actions.includes('open'))).toBe(true);
  });
});
