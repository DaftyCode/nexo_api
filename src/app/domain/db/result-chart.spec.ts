import { describe, expect, it } from 'vitest';
import {
  ResultChartConfig,
  autoChart,
  chartData,
  chartKey,
  numberOf,
  readChartConfig,
  readCharts,
} from './result-chart';
import { CHART_FRAME, chartGeometry } from './result-chart/geometry';
import type { ResultColumn } from './results';

const column = (name: string, kind: string): ResultColumn => ({ name, kind, typeName: kind });
const columns = [
  column('day', 'date'),
  column('city', 'text'),
  column('n', 'integer'),
  column('total', 'decimal'),
];
const rows = [
  ['2024-01-02', 'Lima', 1, { $t: 'decimal', v: '10.5' }],
  ['2024-01-01', 'Lima', 2, 20],
  ['2024-01-02', 'Quito', 3, null],
  ['2024-01-01', 'Bogotá', 4, 5],
  [null, 'Lima', 5, 1],
];
const config = (patch: Partial<ResultChartConfig>): ResultChartConfig => ({
  ...autoChart(columns),
  ...patch,
});

describe('the chart of a result', () => {
  it('chooses a time line for a date and bars for a text, with the numbers as series', () => {
    expect(autoChart(columns)).toMatchObject({
      type: 'line',
      x: 'day',
      y: ['n', 'total'],
      aggregate: 'sum',
      limit: 0,
    });
    expect(autoChart([column('city', 'text'), column('n', 'integer')])).toMatchObject({
      type: 'bar',
      x: 'city',
      limit: 20,
    });
    expect(autoChart([column('a', 'integer'), column('b', 'float')])).toMatchObject({
      type: 'scatter',
      x: 'a',
      y: ['b'],
    });
    expect(autoChart([column('city', 'text')])).toMatchObject({ y: [], aggregate: 'count' });
    expect(autoChart([])).toMatchObject({ x: '', type: 'bar' });
  });

  it('aggregates repeated X values and orders dates in time', () => {
    const data = chartData(config({ y: ['n'] }), columns, rows);
    expect(data.xKind).toBe('date');
    expect(data.categories.map((each) => each.label)).toEqual(['2024-01-01', '2024-01-02', 'NULL']);
    expect(data.series).toEqual([{ name: 'n', values: [6, 4, 5] }]);
    for (const [how, values] of [
      ['avg', [3, 2, 5]],
      ['count', [2, 2, 1]],
      ['min', [2, 1, 5]],
      ['max', [4, 3, 5]],
    ] as const)
      expect(
        chartData(config({ y: ['n'], aggregate: how }), columns, rows).series[0].values,
      ).toEqual(values);
    // Typed decimals count; a NULL is not a value.
    expect(
      chartData(config({ y: ['total'], aggregate: 'max' }), columns, rows).series[0].values,
    ).toEqual([20, 10.5, 1]);
  });

  it('makes a series per value of a column, orders by size and gathers the rest', () => {
    const grouped = chartData(
      config({ x: 'city', y: ['n'], group: 'day', type: 'stacked' }),
      columns,
      rows,
    );
    expect(grouped.xKind).toBe('text');
    expect(grouped.categories.map((each) => each.label)).toEqual(['Lima', 'Quito', 'Bogotá']);
    expect(grouped.series.map((each) => each.name)).toEqual(['2024-01-02', '2024-01-01', 'NULL']);
    expect(grouped.series[0].values).toEqual([1, 3, null]);
    const both = chartData(config({ x: 'city', y: ['n', 'total'], group: 'day' }), columns, rows);
    expect(both.series[0].name).toBe('2024-01-02 · n');
    const top = chartData(
      config({ x: 'city', y: ['n'], order: 'desc', limit: 1, type: 'bar' }),
      columns,
      rows,
    );
    expect(top.categories).toEqual([
      { label: 'Lima', at: 0 },
      { label: '', at: 1, rest: true },
    ]);
    expect(top.series[0].values).toEqual([8, 7]);
    const asc = chartData(config({ x: 'city', y: ['n'], order: 'asc' }), columns, rows);
    expect(asc.categories.map((each) => each.label)).toEqual(['Quito', 'Bogotá', 'Lima']);
    const counted = chartData(config({ x: 'city', y: [] }), columns, rows);
    expect(counted.series).toEqual([{ name: 'count', values: [3, 1, 1] }]);
    const numbers = chartData(
      config({ x: 'n', y: ['total'], type: 'scatter', limit: 2 }),
      columns,
      rows,
    );
    expect(numbers.categories.map((each) => each.at)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads numbers and a stored chart, and keys it by its statement', () => {
    expect([
      numberOf(3),
      numberOf('4.5'),
      numberOf(true),
      numberOf(''),
      numberOf('x'),
      numberOf(null),
      numberOf(Infinity),
    ]).toEqual([3, 4.5, 1, null, null, null, null]);
    expect(
      readChartConfig({
        type: 'pie',
        x: 'city',
        y: ['n', 3],
        limit: 5000,
        order: 'desc',
        aggregate: 'avg',
        log: true,
      }),
    ).toEqual({
      type: 'pie',
      x: 'city',
      y: ['n'],
      group: '',
      aggregate: 'avg',
      order: 'desc',
      limit: 0,
      log: true,
      title: '',
      xLabel: '',
      yLabel: '',
    });
    expect(readChartConfig({ type: 'radar', x: 'a' })).toBeUndefined();
    expect(readChartConfig(null)).toBeUndefined();
    expect(chartKey('  SELECT 1\n  FROM t ')).toBe('SELECT 1 FROM t');
    expect(readCharts({ 'SELECT 1': { type: 'bar', x: 'a' }, bad: { type: 'radar' } })).toEqual({
      charts: { 'SELECT 1': expect.objectContaining({ type: 'bar', x: 'a' }) },
    });
    expect(readCharts({ bad: 1 })).toEqual({});
    expect(readCharts('x')).toEqual({});
  });
});

describe('the geometry of a result chart', () => {
  const data = {
    xKind: 'text' as const,
    categories: [
      { label: 'a', at: 0 },
      { label: 'b', at: 1 },
    ],
    series: [
      { name: 's1', values: [10, null] },
      { name: 's2', values: [5, 20] },
    ],
  };

  it('draws bars side by side, stacked and lying down, from zero', () => {
    const bars = chartGeometry(data, 'bar', [0, 1]);
    expect(bars.vertical).toBe(true);
    expect(bars.shapes.map((each) => [each.series, each.category, each.value])).toEqual([
      [0, 0, 10],
      [1, 0, 5],
      [1, 1, 20],
    ]);
    expect(bars.marks.map((each) => each.value)).toEqual([0, 5, 10, 15, 20]);
    const base = CHART_FRAME.height - CHART_FRAME.bottom;
    expect(bars.shapes[0].y + bars.shapes[0].height!).toBeCloseTo(base, 0);
    const stacked = chartGeometry(data, 'stacked', [0, 1]);
    expect(stacked.shapes[1].y + stacked.shapes[1].height!).toBeCloseTo(stacked.shapes[0].y, 0);
    const lying = chartGeometry(data, 'hbar', [1]);
    expect(lying.vertical).toBe(false);
    expect(lying.shapes[0].x).toBe(CHART_FRAME.left);
    // A hidden series is not drawn.
    expect(chartGeometry(data, 'bar', [1]).shapes.every((each) => each.series === 1)).toBe(true);
  });

  it('draws lines, areas and dots, in time for dates, and a log scale of powers of ten', () => {
    const timed = {
      ...data,
      xKind: 'date' as const,
      categories: [
        { label: 'x', at: 0 },
        { label: 'y', at: 100 },
      ],
    };
    const lines = chartGeometry(timed, 'area', [0, 1]);
    expect(lines.lines).toHaveLength(2);
    expect(lines.lines[1].area).toMatch(/Z$/);
    expect(lines.labels.map((each) => each.at)).toEqual([
      CHART_FRAME.left,
      CHART_FRAME.width - CHART_FRAME.right,
    ]);
    const dots = chartGeometry(timed, 'scatter', [1]);
    expect(dots.lines).toEqual([]);
    expect(dots.shapes.map((each) => each.r)).toEqual([4, 4]);
    const logged = chartGeometry(
      { ...data, series: [{ name: 's', values: [1, 1000] }] },
      'line',
      [0],
      true,
    );
    expect(logged.marks.map((each) => each.value)).toEqual([1, 10, 100, 1000]);
    const negative = chartGeometry(
      { ...data, series: [{ name: 's', values: [-3, 4] }] },
      'bar',
      [0],
    );
    expect(negative.marks[0].value).toBe(-5);
  });

  it('draws a pie of the first series shown, a whole circle for one category', () => {
    const pie = chartGeometry(data, 'pie', [1]);
    expect(pie.shapes.map((each) => each.category)).toEqual([0, 1]);
    expect(pie.shapes[0].d).toMatch(/^M .* A /);
    const whole = chartGeometry({ ...data, series: [{ name: 's', values: [3, 0] }] }, 'pie', [0]);
    expect(whole.shapes).toHaveLength(1);
    expect(whole.shapes[0].d).toContain(' 0 1 1 ');
    expect(chartGeometry(data, 'pie', []).shapes).toEqual([]);
  });
});
