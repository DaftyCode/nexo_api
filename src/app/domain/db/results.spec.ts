import { ResultTab, addResult, cellText, rerunResult, resultTitle, summarize } from './results';

const tab = (id: string, extra: Partial<ResultTab> = {}): ResultTab => ({
  id,
  order: Number(id.replace(/\D/g, '')) || 1,
  sql: `select ${id}`,
  pinned: false,
  columns: [],
  rows: [],
  startedAt: 0,
  executeMs: 0,
  fetchMs: 0,
  ...extra,
});
const ids = (tabs: readonly ResultTab[]) => tabs.map((item) => item.id);

describe('accumulated result tabs', () => {
  it('keeps a tab per query, and closes the oldest unpinned past the most', () => {
    let tabs: ResultTab[] = [];
    for (const id of ['r1', 'r2', 'r3'])
      tabs = addResult(tabs, tab(id), { reuse: false, max: 15 }).tabs;
    expect(ids(tabs)).toEqual(['r1', 'r2', 'r3']);
    tabs = tabs.map((item) => (item.id === 'r1' ? { ...item, pinned: true } : item));
    const closed: string[] = [];
    for (let index = 4; index <= 24; index++) {
      const added = addResult(tabs, tab(`r${index}`), { reuse: false, max: 15 });
      tabs = added.tabs;
      closed.push(...ids(added.closed));
    }
    expect(tabs).toHaveLength(15);
    expect(tabs[0].id).toBe('r1');
    expect(closed.slice(0, 2)).toEqual(['r2', 'r3']);
    expect(ids(tabs).at(-1)).toBe('r24');
  });

  it('reuses the last unpinned tab when asked, and never a pinned one', () => {
    const tabs = [tab('r1'), tab('r2', { pinned: true })];
    const reused = addResult(tabs, tab('r3'), { reuse: true, max: 15 });
    expect(ids(reused.tabs)).toEqual(['r3', 'r2']);
    expect(ids(reused.closed)).toEqual(['r1']);
    const pinned = addResult([tab('r2', { pinned: true })], tab('r3'), { reuse: true, max: 15 });
    expect(ids(pinned.tabs)).toEqual(['r2', 'r3']);
  });

  it('keeps every pinned tab even past the most', () => {
    const tabs = [tab('r1', { pinned: true }), tab('r2', { pinned: true })];
    expect(ids(addResult(tabs, tab('r3'), { reuse: false, max: 2 }).tabs)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
  });

  it('runs again into the same tab, with its number and pin', () => {
    const tabs = rerunResult([tab('r1', { order: 4, pinned: true })], 'r1', tab('new'));
    expect(tabs[0]).toEqual(
      expect.objectContaining({ id: 'r1', order: 4, pinned: true, sql: 'select new' }),
    );
  });

  it('titles a tab by its number and the start of its statement', () => {
    expect(resultTitle({ order: 2, sql: 'SELECT *\n  FROM orders' })).toBe(
      '2 · SELECT * FROM orders',
    );
    expect(resultTitle({ order: 1, sql: 'x'.repeat(40) })).toBe(`1 · ${'x'.repeat(32)}…`);
  });

  it('writes typed values as text and sums up the columns', () => {
    expect(cellText(null)).toBe('NULL');
    expect(cellText({ $t: 'decimal', v: '10.50' })).toBe('10.50');
    expect(cellText({ $t: 'text', v: 'abc', truncated: true, size: 9 })).toBe('abc…');
    expect(cellText([1, null])).toBe('[1, NULL]');
    const columns = [
      { name: 'id', typeName: 'int8', kind: 'integer' },
      { name: 'name', typeName: 'text', kind: 'text' },
    ];
    const rows = [
      [{ $t: 'integer', v: '10' }, 'b'],
      [{ $t: 'integer', v: '9' }, null],
      [{ $t: 'integer', v: '10' }, 'a'],
    ];
    expect(summarize(columns, rows)).toEqual([
      { name: 'id', distinct: 2, nulls: 0, min: '9', max: '10' },
      { name: 'name', distinct: 2, nulls: 1, min: 'a', max: 'b' },
    ]);
  });
});
