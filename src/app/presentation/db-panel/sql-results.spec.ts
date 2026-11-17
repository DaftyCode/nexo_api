import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseUseCases } from '../../application/database-use-cases';
import type { ResultTab } from '../../domain/db/results';
import { emptyView } from '../../domain/db/grid/view';
import { SqlResults } from './sql-results';

const tab = (id: string, extra: Partial<ResultTab> = {}): ResultTab => ({
  id,
  order: 1,
  sql: `select ${id}`,
  pinned: false,
  columns: [{ name: 'n', typeName: 'int', kind: 'integer' }],
  rows: [[1]],
  startedAt: 0,
  executeMs: 1,
  fetchMs: 0,
  ...extra,
});

function fixture(fetch: (cursor: string) => unknown = () => ({ rows: [[2]], cursor: null })) {
  const calls: [string, Record<string, unknown>][] = [];
  const reruns: string[] = [];
  const cases = new DatabaseUseCases({
    execute: async (operation: string, payload: Record<string, unknown>) => {
      calls.push([operation, payload]);
      if (operation === 'db.fetch') return fetch(String(payload['cursor']));
      return {};
    },
  } as never);
  const results = new SqlResults({
    cases: async () => cases,
    workspace: () => 'w',
    session: 's',
    max: () => 2,
    rerun: async (run) => void reruns.push(run.id),
  });
  return { results, calls, reruns };
}

afterEach(() => vi.useRealTimers());

describe('the results of a SQL tab', () => {
  it('keeps the newest tabs, closing the cursors of those that go', async () => {
    const { results, calls } = fixture();
    results.add(tab('a', { cursor: 'ka' }), false);
    results.setView('a', { ...emptyView(), filter: 'x' });
    results.add(tab('b'), false);
    results.add(tab('c'), false);
    await Promise.resolve();
    expect(results.tabs().map((each) => each.id)).toEqual(['b', 'c']);
    expect(results.view('a')).toEqual(emptyView());
    expect(calls).toContainEqual(['db.close', { workspace: 'w', session: 's', cursor: 'ka' }]);
    expect(results.active()).toBe('c');
  });

  it('replaces a tab with a new run, pins and closes them', async () => {
    const { results, calls } = fixture();
    results.add(tab('a', { cursor: 'old' }), false);
    results.replace('a', tab('fresh', { order: 9 }));
    results.replace('missing', tab('x'));
    await Promise.resolve();
    expect(results.tabs()[0]).toMatchObject({ id: 'a', order: 1, sql: 'select fresh' });
    expect(calls.some(([operation]) => operation === 'db.close')).toBe(true);
    results.pin('a');
    expect(results.tabs()[0].pinned).toBe(true);
    results.add(tab('b'), false);
    results.detached.set('b');
    results.close((each) => !each.pinned);
    expect(results.tabs().map((each) => each.id)).toEqual(['a']);
    expect(results.active()).toBe('a');
    expect(results.detached()).toBe('');
    results.close(() => true);
    expect(results.active()).toBe('');
  });

  it('reads more rows once at a time, every row when asked, and a lost cursor', async () => {
    let pages = 0;
    const { results } = fixture((cursor) => {
      if (cursor === 'gone') throw new Error('closed');
      pages++;
      return { rows: [[pages + 1]], cursor: pages < 3 ? 'k' : null };
    });
    results.add(tab('a', { cursor: 'k' }), false);
    await Promise.all([results.more('a'), results.more('a')]);
    expect(pages).toBe(1);
    await results.readAll('a');
    expect(results.tabs()[0].rows).toEqual([[1], [2], [3], [4]]);
    expect(results.tabs()[0].cursor).toBeUndefined();
    await results.more('a');
    results.add(tab('b', { cursor: 'gone' }), false);
    await results.more('b');
    expect(results.tabs().find((each) => each.id === 'b')).toMatchObject({ lost: true });
    expect(results.fetching().size).toBe(0);
  });

  it('stops reading all when a page brings nothing new', async () => {
    const { results } = fixture(() => ({ rows: [], cursor: 'k' }));
    results.add(tab('a', { cursor: 'k' }), false);
    await results.readAll('a');
    expect(results.tabs()[0].rows).toEqual([[1]]);
  });

  it('runs a result again every few seconds until it is stopped', () => {
    vi.useFakeTimers();
    const { results, reruns } = fixture();
    results.add(tab('a'), false);
    results.repeat('a', 2);
    expect(results.repeating()).toEqual({ a: 2 });
    vi.advanceTimersByTime(4100);
    expect(reruns).toEqual(['a', 'a']);
    results.repeat('a', 0);
    vi.advanceTimersByTime(4000);
    expect(reruns).toHaveLength(2);
    expect(results.repeating()).toEqual({});
    results.repeat('a', 1);
    results.dispose();
    vi.advanceTimersByTime(3000);
    expect(reruns).toHaveLength(2);
  });

  it('keeps the latest messages, and loses every cursor with its session', () => {
    const { results } = fixture();
    for (let i = 0; i < 205; i++) results.note({ kind: 'info', text: `m${i}` });
    expect(results.messages()).toHaveLength(200);
    expect(results.messages()[0].text).toBe('m5');
    results.clearMessages();
    expect(results.messages()).toEqual([]);
    results.add(tab('a', { cursor: 'k' }), false);
    results.add(tab('b'), false);
    results.sessionLost();
    expect(results.tabs().map((each) => each.lost)).toEqual([true, undefined]);
  });
});
