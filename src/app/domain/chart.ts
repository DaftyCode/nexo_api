/**
 * The geometry of a chart, with no library: series of points over time drawn as lines or
 * areas, and values drawn as bars, in a frame of fixed units the SVG scales. Shared by the
 * dashboards of a server (DB-22) and the charts of results (DB-28).
 */
export interface Point {
  at: number;
  value: number;
}
export interface Series {
  name: string;
  points: Point[];
}

/** The frame of a chart: its size, and the room left for the axes' labels. */
export const FRAME = { width: 480, height: 180, left: 52, right: 10, top: 10, bottom: 22 };
type Frame = typeof FRAME;

/** The top of the axis: the maximum rounded up to 1, 2 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((each) => each * power >= max)!;
  return step * power;
}

/** The values of the marks of the vertical axis, from 0 to `max`. */
export const ticks = (max: number, count = 4) =>
  Array.from({ length: count + 1 }, (_, at) => (max * at) / count);

/** A time as a chart labels it: hours, minutes and seconds. */
export function timeLabel(at: number): string {
  const time = new Date(at);
  return [time.getHours(), time.getMinutes(), time.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export interface TimeChart {
  max: number;
  marks: { y: number; value: number }[];
  times: { x: number; at: number }[];
  lines: { name: string; d: string; area: string }[];
  start: number;
  end: number;
}

/** Series over time as lines (and the areas under them), on one scale. */
export function timeChart(series: readonly Series[], frame: Frame = FRAME): TimeChart {
  const all = series.flatMap((each) => each.points);
  const start = Math.min(...all.map((point) => point.at));
  const end = Math.max(...all.map((point) => point.at));
  const max = niceMax(Math.max(0, ...all.map((point) => point.value)));
  const inner = { width: frame.width - frame.left - frame.right };
  const base = frame.height - frame.bottom;
  const height = base - frame.top;
  const x = (at: number) =>
    end > start ? frame.left + ((at - start) / (end - start)) * inner.width : frame.left;
  const y = (value: number) => base - (Math.max(0, value) / max) * height;
  const round = (value: number) => Math.round(value * 10) / 10;
  const lines = series.map((each) => {
    const path = each.points.map((point) => `${round(x(point.at))} ${round(y(point.value))}`);
    const d = path.length ? `M ${path.join(' L ')}` : '';
    const first = each.points[0];
    const last = each.points.at(-1);
    const area =
      first && last ? `${d} L ${round(x(last.at))} ${base} L ${round(x(first.at))} ${base} Z` : '';
    return { name: each.name, d, area };
  });
  const times =
    all.length && end > start
      ? [start, (start + end) / 2, end].map((at) => ({ x: round(x(at)), at }))
      : all.length
        ? [{ x: frame.left, at: start }]
        : [];
  return {
    max,
    marks: ticks(max).map((value) => ({ y: round(y(value)), value })),
    times,
    lines,
    start: all.length ? start : 0,
    end: all.length ? end : 0,
  };
}

/** The point of each series nearest to a time, for what the pointer is over. */
export function valuesAt(series: readonly Series[], at: number) {
  return series.flatMap((each) => {
    let best: Point | undefined;
    for (const point of each.points)
      if (!best || Math.abs(point.at - at) < Math.abs(best.at - at)) best = point;
    return best ? [{ name: each.name, ...best }] : [];
  });
}

/** The time under a horizontal position of the frame. */
export function timeAt(chart: TimeChart, x: number, frame: Frame = FRAME): number {
  const width = frame.width - frame.left - frame.right;
  const share = Math.min(1, Math.max(0, (x - frame.left) / width));
  return chart.start + share * (chart.end - chart.start);
}

export interface BarChart {
  max: number;
  marks: { y: number; value: number }[];
  bars: { name: string; value: number; x: number; y: number; width: number; height: number }[];
}

/** Values as bars side by side, on one scale. */
export function barChart(
  values: readonly { name: string; value: number }[],
  frame: Frame = FRAME,
): BarChart {
  const max = niceMax(Math.max(0, ...values.map((each) => each.value)));
  const base = frame.height - frame.bottom;
  const height = base - frame.top;
  const slot = (frame.width - frame.left - frame.right) / Math.max(1, values.length);
  const width = Math.max(4, slot * 0.7);
  return {
    max,
    marks: ticks(max).map((value) => ({ y: base - (value / max) * height, value })),
    bars: values.map((each, at) => {
      const size = (Math.max(0, each.value) / max) * height;
      return {
        name: each.name,
        value: each.value,
        x: frame.left + at * slot + (slot - width) / 2,
        y: base - size,
        width,
        height: size,
      };
    }),
  };
}
