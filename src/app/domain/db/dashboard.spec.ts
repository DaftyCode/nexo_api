import { describe, expect, it } from 'vitest';
import {
  addReading,
  emptyLayout,
  formatValue,
  orderedPanels,
  readDashboardLayouts,
  readPanels,
  readingOf,
} from './dashboard';

describe('the dashboard of a server', () => {
  it('reads the panels of a driver and the layouts kept, defensively', () => {
    expect(
      readPanels({
        dashboards: [
          {
            id: 'tps',
            title: 'Transactions',
            sql: 'SELECT 1',
            chart: 'area',
            unit: 'tx',
            delta: true,
            interval: 0.2,
          },
          { id: 'x', sql: 'SELECT 2', chart: 'pie' },
          { title: 'No id', sql: 'SELECT 3' },
        ],
      }),
    ).toEqual([
      {
        id: 'tps',
        title: 'Transactions',
        sql: 'SELECT 1',
        chart: 'area',
        unit: 'tx',
        delta: true,
        interval: 1,
      },
      { id: 'x', title: 'x', sql: 'SELECT 2', chart: 'line', delta: false, interval: 5 },
    ]);
    expect(readPanels(null)).toEqual([]);
    expect(
      readDashboardLayouts({
        c1: {
          order: ['b', 'a', 3],
          hidden: ['c'],
          wide: 'no',
          interval: 0.5,
          custom: [{ id: 'mine', sql: 'SELECT 1', chart: 'bar' }, { id: 'bad' }],
        },
        c2: null,
      }),
    ).toEqual({
      c1: {
        order: ['b', 'a'],
        hidden: ['c'],
        wide: [],
        interval: 1,
        custom: [
          {
            id: 'mine',
            title: 'mine',
            sql: 'SELECT 1',
            chart: 'bar',
            delta: false,
            interval: 5,
            custom: true,
          },
        ],
      },
      c2: emptyLayout(),
    });
  });

  it('puts the panels in the order kept, the new ones after', () => {
    const panel = (id: string) => ({
      id,
      title: id,
      sql: 's',
      chart: 'line' as const,
      delta: false,
      interval: 5,
    });
    const ordered = orderedPanels([panel('a'), panel('b'), panel('c')], {
      ...emptyLayout(),
      order: ['c', 'a'],
    });
    expect(ordered.map((each) => each.id)).toEqual(['c', 'a', 'b']);
  });

  it('reads one row as a series per number, and several rows as label and value', () => {
    expect(
      readingOf(
        [{ name: 'active' }, { name: 'idle' }, { name: 'name' }, { name: 'big' }],
        [[3, '4', 'shop', { $t: 'decimal', v: '12.5' }]],
      ),
    ).toEqual({ active: 3, idle: 4, big: 12.5 });
    expect(
      readingOf(
        [{ name: 'Variable_name' }, { name: 'Value' }],
        [
          ['Threads_connected', '7'],
          ['Threads_running', '2'],
          [null, 'x'],
        ],
      ),
    ).toEqual({ Threads_connected: 7, Threads_running: 2 });
    expect(readingOf([{ name: 'a' }], [])).toEqual({});
  });

  it('draws counters as changes per second, and starts again when one goes back', () => {
    let data = addReading({ series: [] }, { commits: 100 }, 1_000, true);
    expect(data.series).toEqual([{ name: 'commits', points: [] }]);
    data = addReading(data, { commits: 130 }, 3_000, true);
    expect(data.series[0].points).toEqual([{ at: 3_000, value: 15 }]);
    data = addReading(data, { commits: 5 }, 4_000, true);
    expect(data.series[0].points).toHaveLength(1);
    data = addReading(data, { commits: 25 }, 5_000, true);
    expect(data.series[0].points.at(-1)).toEqual({ at: 5_000, value: 20 });
    expect(data.last).toEqual({ at: 5_000, values: { commits: 25 } });
  });

  it('keeps values as they are, and only the last points', () => {
    let data = { series: [] } as ReturnType<typeof addReading>;
    for (let at = 0; at < 5; at++)
      data = addReading(data, { active: at, idle: 1 }, at * 1000, false, 3);
    expect(data.series.map((each) => [each.name, each.points.map((point) => point.value)])).toEqual(
      [
        ['active', [2, 3, 4]],
        ['idle', [1, 1, 1]],
      ],
    );
  });

  it('writes bytes in their unit and other numbers short, per second when they are', () => {
    expect(formatValue(512, 'bytes')).toBe('512 B');
    expect(formatValue(1536, 'bytes')).toBe('1.5 KB');
    expect(formatValue(3 * 1024 ** 3, 'bytes', true)).toBe('3.0 GB/s');
    expect(formatValue(7, 'sessions')).toBe('7 sessions');
    expect(formatValue(2.345, 'tx', true)).toBe('2.35 tx/s');
    expect(formatValue(12.34)).toBe('12.3');
    expect(formatValue(45_000)).toBe('45.0k');
    expect(formatValue(2_500_000)).toBe('2.5M');
    expect(formatValue(3e9)).toBe('3.0G');
  });
});
