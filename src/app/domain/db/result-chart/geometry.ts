/**
 * Where a result chart draws each thing, in a frame of fixed units the SVG scales: the marks
 * of the value axis (linear from zero, or powers of ten), the labels of the categories, and a
 * shape per value (a point of a line, a bar, a segment of a stack, a slice, a dot), each with
 * its series, its category and its value for what the pointer or the keyboard is on.
 */
import { niceMax } from '../../chart';
import type { ChartData, ChartType } from '../result-chart';

export const CHART_FRAME = { width: 640, height: 300, left: 60, right: 16, top: 16, bottom: 56 };

export interface ChartShape {
  kind: 'rect' | 'circle' | 'path';
  series: number;
  category: number;
  value: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  r?: number;
  d?: string;
}
export interface ChartGeometry {
  /** Marks of the value axis, where they go along it. */
  marks: { at: number; value: number }[];
  /** Labels of the categories along the other axis. */
  labels: { at: number; category: number }[];
  /** The line (and the area under it) of each series of a line or area chart. */
  lines: { series: number; d: string; area: string }[];
  shapes: ChartShape[];
  /** The value axis is vertical (it is horizontal for horizontal bars). */
  vertical: boolean;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The scale of the values: linear from 0 (or from a negative minimum), or logarithmic. */
function scale(min: number, max: number, log: boolean, length: number) {
  if (log) {
    const low = Math.floor(Math.log10(Math.max(min, Number.MIN_VALUE)));
    const high = Math.max(low + 1, Math.ceil(Math.log10(Math.max(max, 1e-300))));
    const position = (value: number) =>
      value > 0 ? ((Math.log10(value) - low) / (high - low)) * length : 0;
    const marks = Array.from({ length: high - low + 1 }, (_, at) => 10 ** (low + at));
    return { position, marks };
  }
  const top = niceMax(max);
  const bottom = min < 0 ? -niceMax(-min) : 0;
  const position = (value: number) => ((value - bottom) / (top - bottom)) * length;
  const marks = Array.from({ length: 5 }, (_, at) => bottom + ((top - bottom) * at) / 4);
  return { position, marks };
}

/** The geometry of a chart of `data`, with only the `shown` series. */
export function chartGeometry(
  data: ChartData,
  type: ChartType,
  shown: readonly number[],
  log = false,
  frame = CHART_FRAME,
): ChartGeometry {
  const series = shown.filter((index) => data.series[index]);
  const count = data.categories.length;
  const vertical = type !== 'hbar';
  const along = vertical
    ? frame.width - frame.left - frame.right
    : frame.height - frame.top - frame.bottom;
  const across = vertical
    ? frame.height - frame.top - frame.bottom
    : frame.width - frame.left - frame.right;
  const value = (s: number, c: number) => data.series[s].values[c];
  const stacked = type === 'stacked';
  const totals = data.categories.map((_, c) =>
    series.reduce((sum, s) => sum + Math.max(0, value(s, c) ?? 0), 0),
  );
  const all = series.flatMap((s) => data.series[s].values.filter((v): v is number => v !== null));
  const positive = all.filter((v) => v > 0);
  const max = stacked ? Math.max(0, ...totals) : Math.max(0, ...all);
  const min = log ? Math.min(...(positive.length ? positive : [1])) : Math.min(0, ...all);
  const { position, marks } = scale(min, max, log, across);
  const base = frame.height - frame.bottom;
  // A value along its axis, as a coordinate of the frame.
  const level = (v: number) => (vertical ? base - position(v) : frame.left + position(v));
  const continuous =
    (type === 'line' || type === 'area' || type === 'scatter') && data.xKind !== 'text';
  const ats = data.categories.map((each) => each.at);
  const [first, last] = [Math.min(...ats), Math.max(...ats)];
  const slot = along / Math.max(1, count);
  const place = (c: number) =>
    continuous && last > first ? ((ats[c] - first) / (last - first)) * along : slot * (c + 0.5);
  const spot = (c: number) => (vertical ? frame.left + place(c) : frame.top + place(c));
  const geometry: ChartGeometry = {
    marks: marks.map((each) => ({ at: round(level(each)), value: each })),
    labels: data.categories.map((_, c) => ({ at: round(spot(c)), category: c })),
    lines: [],
    shapes: [],
    vertical,
  };
  if (type === 'pie') return pie(data, series[0], frame, geometry);
  if (type === 'line' || type === 'area' || type === 'scatter') {
    for (const s of series) {
      const points: string[] = [];
      for (let c = 0; c < count; c++) {
        const v = value(s, c);
        if (v === null || (log && v <= 0)) continue;
        const [x, y] = [round(spot(c)), round(level(v))];
        points.push(`${x} ${y}`);
        geometry.shapes.push({
          kind: 'circle',
          series: s,
          category: c,
          value: v,
          x,
          y,
          r: type === 'scatter' ? 4 : 3,
        });
      }
      if (type !== 'scatter' && points.length) {
        const d = `M ${points.join(' L ')}`;
        const [x0] = points[0].split(' ');
        const [x1] = points.at(-1)!.split(' ');
        geometry.lines.push({ series: s, d, area: `${d} L ${x1} ${base} L ${x0} ${base} Z` });
      }
    }
    return geometry;
  }
  // Bars: side by side, or stacked.
  const width = Math.max(2, slot * 0.8);
  const each = stacked ? width : width / Math.max(1, series.length);
  const zero = level(log ? (marks[0] ?? 1) : Math.max(0, Math.min(0, max)));
  for (let c = 0; c < count; c++) {
    let stack = 0;
    series.forEach((s, at) => {
      const v = value(s, c);
      if (v === null || (log && v <= 0)) return;
      const from = stacked ? level(stack) : zero;
      const to = stacked ? level((stack += Math.max(0, v))) : level(v);
      const start = place(c) - width / 2 + (stacked ? 0 : at * each);
      const [low, high] = [Math.min(from, to), Math.max(from, to)];
      geometry.shapes.push(
        vertical
          ? {
              kind: 'rect',
              series: s,
              category: c,
              value: v,
              x: round(frame.left + start),
              y: round(low),
              width: round(each),
              height: round(high - low),
            }
          : {
              kind: 'rect',
              series: s,
              category: c,
              value: v,
              x: round(low),
              y: round(frame.top + start),
              width: round(high - low),
              height: round(each),
            },
      );
    });
  }
  return geometry;
}

/** A pie of the first series shown: a slice per category, from the top clockwise. */
function pie(
  data: ChartData,
  s: number | undefined,
  frame: typeof CHART_FRAME,
  geometry: ChartGeometry,
) {
  if (s === undefined) return { ...geometry, marks: [], labels: [] };
  const values = data.series[s].values.map((v) => Math.max(0, v ?? 0));
  const total = values.reduce((sum, v) => sum + v, 0);
  const cx = frame.width / 2;
  const cy = (frame.height - frame.bottom + frame.top) / 2;
  const r = Math.min(frame.width, frame.height - frame.bottom - frame.top) / 2 - 4;
  let angle = -Math.PI / 2;
  const shapes: ChartShape[] = [];
  values.forEach((v, c) => {
    if (!total || !v) return;
    const turn = (v / total) * Math.PI * 2;
    const [x0, y0] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    angle += turn;
    const [x1, y1] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    const d =
      turn >= Math.PI * 2 - 1e-9
        ? `M ${round(cx)} ${round(cy - r)} A ${round(r)} ${round(r)} 0 1 1 ${round(cx - 0.01)} ${round(cy - r)} Z`
        : `M ${round(cx)} ${round(cy)} L ${round(x0)} ${round(y0)} A ${round(r)} ${round(r)} 0 ${turn > Math.PI ? 1 : 0} 1 ${round(x1)} ${round(y1)} Z`;
    shapes.push({
      kind: 'path',
      series: c,
      category: c,
      value: data.series[s].values[c] ?? 0,
      x: round(cx),
      y: round(cy),
      d,
    });
  });
  return { ...geometry, marks: [], labels: [], shapes };
}
