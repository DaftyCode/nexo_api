import { describe, expect, it } from 'vitest';
import { FRAME, barChart, niceMax, ticks, timeAt, timeChart, timeLabel, valuesAt } from './chart';

describe('the geometry of a chart', () => {
  it('rounds the top of the axis up, and marks it in equal steps', () => {
    expect([0, -3, 0.3, 1, 7, 12, 200, 2001].map(niceMax)).toEqual([
      1, 1, 0.5, 1, 10, 20, 200, 5000,
    ]);
    expect(ticks(20)).toEqual([0, 5, 10, 15, 20]);
  });

  it('draws series over time on one scale, the areas closed on the base', () => {
    const chart = timeChart([
      {
        name: 'active',
        points: [
          { at: 0, value: 0 },
          { at: 10_000, value: 8 },
        ],
      },
      { name: 'idle', points: [{ at: 5_000, value: 4 }] },
      { name: 'none', points: [] },
    ]);
    expect(chart.max).toBe(10);
    const base = FRAME.height - FRAME.bottom;
    expect(chart.lines[0].d).toBe(
      `M ${FRAME.left} ${base} L ${FRAME.width - FRAME.right} ${Math.round((base - 0.8 * (base - FRAME.top)) * 10) / 10}`,
    );
    expect(chart.lines[0].area.endsWith(`L ${FRAME.left} ${base} Z`)).toBe(true);
    expect(chart.lines[2]).toEqual({ name: 'none', d: '', area: '' });
    expect(chart.times.map((time) => time.at)).toEqual([0, 5_000, 10_000]);
    expect(chart.marks[0]).toEqual({ y: base, value: 0 });
    expect(timeAt(chart, FRAME.left)).toBe(0);
    expect(timeAt(chart, 10_000)).toBe(10_000);
    expect(
      valuesAt(
        [
          {
            name: 'a',
            points: [
              { at: 0, value: 1 },
              { at: 9, value: 2 },
            ],
          },
        ],
        7,
      ),
    ).toEqual([{ name: 'a', at: 9, value: 2 }]);
  });

  it('draws one point, or none, without dividing by nothing', () => {
    const one = timeChart([{ name: 'size', points: [{ at: 5, value: 3 }] }]);
    expect(one.lines[0].d).toBe(
      `M ${FRAME.left} ${Math.round((FRAME.height - FRAME.bottom - 0.6 * (FRAME.height - FRAME.bottom - FRAME.top)) * 10) / 10}`,
    );
    expect(one.times).toEqual([{ x: FRAME.left, at: 5 }]);
    const none = timeChart([]);
    expect([none.max, none.times, none.start, none.end]).toEqual([1, [], 0, 0]);
  });

  it('draws values as bars side by side', () => {
    const chart = barChart([
      { name: 'shop', value: 10 },
      { name: 'crm', value: 5 },
    ]);
    expect(chart.max).toBe(10);
    expect(chart.bars[0].height).toBe(FRAME.height - FRAME.bottom - FRAME.top);
    expect(chart.bars[1].height).toBe(chart.bars[0].height / 2);
    expect(chart.bars[1].x).toBeGreaterThan(chart.bars[0].x);
    expect(barChart([]).bars).toEqual([]);
  });

  it('labels a time with hours, minutes and seconds', () => {
    expect(timeLabel(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});
