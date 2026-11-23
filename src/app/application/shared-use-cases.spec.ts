import { SharedUseCases } from './shared-use-cases';

describe('SharedUseCases', () => {
  it('asks the backend for each part of sharing, without a team key it was not given', async () => {
    const calls: { operation: string; payload: Record<string, unknown> }[] = [];
    const link = { collection: 'c1', name: 'Shop', path: 'D:/x.nexo-collection' };
    const answers: Record<string, unknown> = {
      'shared.status': { links: [link] },
      'shared.poll': {},
      'shared.share': { collection: 'c1', key: 'nexo-team-key-1' },
      'shared.link': { collection: 'c2' },
      'shared.sync': { links: [link] },
      'shared.resolve': { links: [] },
      'shared.unlink': { links: [] },
      'shared.key': {},
    };
    const cases = new SharedUseCases({
      execute: async <T>(operation: string, payload: Record<string, unknown>) => {
        calls.push({ operation, payload });
        return answers[operation] as T;
      },
    } as never);
    expect(await cases.status('local')).toEqual([link]);
    expect(await cases.poll('local')).toEqual({ changed: [], links: [] });
    await cases.poll('local', true);
    expect(
      await cases.share('local', 'c1', { path: 'D:/x.nexo-collection' }, true, ['e1']),
    ).toEqual({
      collection: 'c1',
      key: 'nexo-team-key-1',
    });
    await cases.link('local', { path: 'D:/y.nexo-collection' }, ' nexo-team-key-2 ');
    await cases.link(
      'local',
      { url: 'https://dav.test/y.nexo-collection', credential: { scheme: 'bearer', secret: 't' } },
      '  ',
    );
    expect(await cases.sync('local', 'c1')).toEqual([link]);
    expect(await cases.resolve('local', 'c1', 'r1', 'mine')).toEqual([]);
    expect(await cases.unlink('local', 'c1')).toEqual([]);
    expect(await cases.key('local', 'c1')).toBe('');
    expect(calls.map((call) => [call.operation, call.payload])).toEqual([
      ['shared.status', { workspace: 'local' }],
      ['shared.poll', { workspace: 'local' }],
      ['shared.poll', { workspace: 'local', opening: true }],
      [
        'shared.share',
        {
          workspace: 'local',
          collection: 'c1',
          path: 'D:/x.nexo-collection',
          encrypt: true,
          environments: ['e1'],
        },
      ],
      ['shared.link', { workspace: 'local', path: 'D:/y.nexo-collection', key: 'nexo-team-key-2' }],
      [
        'shared.link',
        {
          workspace: 'local',
          url: 'https://dav.test/y.nexo-collection',
          credential: { scheme: 'bearer', secret: 't' },
        },
      ],
      ['shared.sync', { workspace: 'local', collection: 'c1' }],
      ['shared.resolve', { workspace: 'local', collection: 'c1', id: 'r1', keep: 'mine' }],
      ['shared.unlink', { workspace: 'local', collection: 'c1' }],
      ['shared.key', { workspace: 'local', collection: 'c1' }],
    ]);
  });
});
