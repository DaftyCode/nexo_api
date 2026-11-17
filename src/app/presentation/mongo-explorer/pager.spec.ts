import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import type { MongoExplorer } from '../mongo-explorer';
import { MongoPager } from './pager';

const doc = (n: number) => ({ n });

function fixture(options: { query?: Record<string, unknown> | undefined; pageSize?: string } = {}) {
  const asked: [string, unknown][] = [];
  const failures: unknown[] = [];
  let pages = 0;
  let failNext = false;
  const queries = {
    find: async (...args: unknown[]) => {
      asked.push(['find', args[4]]);
      return { documents: [doc(1), doc(2)], truncated: false, elapsedMs: 1, cursor: 'k' };
    },
    more: async () => {
      if (failNext) throw new Error('cursor lost');
      pages++;
      asked.push(['more', pages]);
      return {
        documents: [doc(10 + pages)],
        truncated: false,
        elapsedMs: 1,
        cursor: pages < 6 ? 'k' : undefined,
      };
    },
    count: async () => {
      asked.push(['count', 1]);
      return 42;
    },
    cancel: async () => void asked.push(['cancel', 1]),
    close: async () => void asked.push(['close', 1]),
  };
  const explorer = {
    target: signal<unknown>({ database: 'shop', collection: 'orders' }),
    query: signal<Record<string, unknown> | undefined>('query' in options ? options.query : {}),
    model: () => ({ pageSize: options.pageSize ?? '2' }),
    use: async (work: (cases: unknown) => unknown) => work({ queries }),
    state: { workspaceId: () => 'w', scopes: () => ({}) },
    connection: () => ({}),
    error: signal(''),
    fail: (error: unknown) => void failures.push(error),
    library: { record: async () => undefined },
  } as unknown as MongoExplorer;
  const pager = new MongoPager(explorer);
  return { pager, asked, failures, explorer, failMore: () => (failNext = true) };
}

describe('the pages of a MongoDB query', () => {
  it('reads pages forward, keeps the last five, and goes back again', async () => {
    const { pager, asked } = fixture();
    expect(pager.hasPrevious()).toBe(false);
    await pager.find();
    for (let i = 0; i < 6; i++) await pager.next();
    expect(pager.pages()).toHaveLength(5);
    expect(pager.hasNext()).toBe(false);
    await pager.next();
    expect(asked.filter(([kind]) => kind === 'more')).toHaveLength(6);
    for (let i = 0; i < 4; i++) await pager.previous();
    expect(pager.page()).toBe(0);
    expect(pager.hasPrevious()).toBe(true);
    await pager.next();
    expect(pager.page()).toBe(1);
    await pager.previous();
    await pager.previous();
    expect(asked.at(-1)?.[0]).toBe('find');
    expect(asked.at(-1)?.[1]).toMatchObject({ skip: expect.any(Number) });
  });

  it('stops at the limit of the query, counts and cancels', async () => {
    const limited = fixture({ query: { limit: 2, skip: 1 } });
    await limited.pager.find(5);
    expect(limited.asked).toEqual([]);
    await limited.pager.find(2);
    expect(limited.asked[0][1]).toMatchObject({ skip: 2, limit: 1 });
    await limited.pager.count();
    expect(limited.pager.total()).toBe(42);
    await limited.pager.cancel();
    limited.pager.running.set('r1');
    await limited.pager.cancel();
    await limited.pager.find();
    await limited.pager.count();
    expect(limited.asked.map(([kind]) => kind)).toEqual(['find', 'count', 'cancel']);
  });

  it('does nothing without a target or a query, and says why a page was lost', async () => {
    const none = fixture({ query: undefined });
    await none.pager.find();
    await none.pager.count();
    await none.pager.previous();
    (none.explorer.target as unknown as { set(value: unknown): void }).set(undefined);
    await none.pager.find();
    await none.pager.count();
    expect(none.asked).toEqual([]);

    const lost = fixture({ pageSize: 'x' });
    await lost.pager.find();
    lost.failMore();
    await lost.pager.next();
    expect(lost.failures).toHaveLength(1);
    expect(lost.pager.hasNext()).toBe(false);
    lost.pager.reset();
    expect(lost.pager.pages()).toEqual([]);
  });
});
