/**
 * The dashboard of a server (DB-22), as DBeaver's: panels that each read a query every few
 * seconds and draw it. A query answers one row (a series per numeric column) or several
 * (a series per row: a label and a value). A counter is drawn as its change per second
 * between two readings; one that went back (the server restarted) starts again.
 */
import type { Series } from '../chart';

export type { Point, Series } from '../chart';
export type ChartKind = 'line' | 'area' | 'bar' | 'value';
export const CHART_KINDS: readonly ChartKind[] = ['line', 'area', 'bar', 'value'];

export interface Panel {
  id: string;
  title: string;
  sql: string;
  chart: ChartKind;
  unit?: string;
  /** Its values are counters: drawn as changes per second. */
  delta: boolean;
  /** Seconds between readings. */
  interval: number;
  /** Written by the person, kept in the layout. */
  custom?: boolean;
}

/** Where the panels of a connection's dashboard are, and how it reads them. */
export interface DashboardLayout {
  /** The panels in the order shown. */
  order: string[];
  hidden: string[];
  /** Panels two columns wide. */
  wide: string[];
  /** Seconds between readings of every panel; its own when 0. */
  interval: number;
  custom: Panel[];
}

/** What a panel has read: its series, and the last reading for the next difference. */
export interface PanelData {
  series: Series[];
  last?: { at: number; values: Record<string, number> };
}

/** Points kept per series, by default. */
export const POINTS = 300;
/** The shortest interval between readings, in seconds. */
export const MIN_INTERVAL = 1;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const texts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function readPanel(value: unknown, custom = false): Panel | undefined {
  const source = record(value);
  if (!text(source['id']) || !text(source['sql'])) return undefined;
  const chart = CHART_KINDS.find((kind) => kind === source['chart']) ?? 'line';
  const interval = Number(source['interval']);
  return {
    id: text(source['id']),
    title: text(source['title']) || text(source['id']),
    sql: text(source['sql']),
    chart,
    ...(text(source['unit']) ? { unit: text(source['unit']) } : {}),
    delta: source['delta'] === true,
    interval: Number.isFinite(interval) ? Math.max(MIN_INTERVAL, interval) : 5,
    ...(custom ? { custom: true } : {}),
  };
}

/** The panels a driver offers (`db.dashboards`). */
export function readPanels(value: unknown): Panel[] {
  const list = record(value)['dashboards'];
  return (Array.isArray(list) ? list : []).flatMap((item) => readPanel(item) ?? []);
}

export const emptyLayout = (): DashboardLayout => ({
  order: [],
  hidden: [],
  wide: [],
  interval: 0,
  custom: [],
});

/** The layouts kept in the session, by connection, read defensively. */
export function readDashboardLayouts(value: unknown): Record<string, DashboardLayout> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([connection, item]) => {
      const layout = record(item);
      const interval = Number(layout['interval']);
      const custom = Array.isArray(layout['custom']) ? layout['custom'] : [];
      return [
        connection,
        {
          order: texts(layout['order']),
          hidden: texts(layout['hidden']),
          wide: texts(layout['wide']),
          interval:
            Number.isFinite(interval) && interval > 0 ? Math.max(MIN_INTERVAL, interval) : 0,
          custom: custom.flatMap((panel) => readPanel(panel, true) ?? []),
        },
      ];
    }),
  );
}

/** The panels in the order of the layout, those it does not name after them. */
export function orderedPanels(panels: readonly Panel[], layout: DashboardLayout): Panel[] {
  const position = (panel: Panel) => {
    const at = layout.order.indexOf(panel.id);
    return at < 0 ? layout.order.length + panels.indexOf(panel) : at;
  };
  return [...panels].sort((a, b) => position(a) - position(b));
}

const number = (value: unknown): number | undefined => {
  const found =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : typeof value === 'object' && value !== null && 'v' in value
          ? Number((value as { v: unknown }).v)
          : NaN;
  return Number.isFinite(found) ? found : undefined;
};

/** The values of a reading: of one row, its numeric columns; of several, label and value. */
export function readingOf(
  columns: readonly { name: string }[],
  rows: readonly (readonly unknown[])[],
): Record<string, number> {
  const values: Record<string, number> = {};
  if (rows.length === 1) {
    columns.forEach((column, at) => {
      const value = number(rows[0][at]);
      if (value !== undefined) values[column.name] = value;
    });
    return values;
  }
  for (const row of rows) {
    const value = number(row[1]);
    if (value !== undefined) values[String(row[0] ?? '')] = value;
  }
  return values;
}

/**
 * A reading added to what a panel read: as it is, or for a counter its change per second
 * since the reading before (none at the first; none for a counter that went back). The
 * oldest points go beyond `keep`.
 */
export function addReading(
  data: PanelData,
  values: Readonly<Record<string, number>>,
  at: number,
  delta: boolean,
  keep = POINTS,
): PanelData {
  const series = new Map(data.series.map((each) => [each.name, [...each.points]]));
  const seconds = data.last ? (at - data.last.at) / 1000 : 0;
  for (const [name, value] of Object.entries(values)) {
    const points = series.get(name) ?? [];
    series.set(name, points);
    if (!delta) points.push({ at, value });
    else {
      const before = data.last?.values[name];
      if (before !== undefined && seconds > 0 && value >= before)
        points.push({ at, value: (value - before) / seconds });
    }
    if (points.length > keep) points.splice(0, points.length - keep);
  }
  return {
    series: [...series].map(([name, points]) => ({ name, points })),
    last: { at, values: { ...values } },
  };
}

const BYTES = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** A value as a panel shows it: bytes in their unit, other numbers short, per second. */
export function formatValue(value: number, unit = '', perSecond = false): string {
  const suffix = perSecond ? '/s' : '';
  if (unit === 'bytes') {
    let size = value;
    let step = 0;
    while (Math.abs(size) >= 1024 && step < BYTES.length - 1) {
      size /= 1024;
      step++;
    }
    return `${step ? size.toFixed(1) : Math.round(size)} ${BYTES[step]}${suffix}`;
  }
  const abs = Math.abs(value);
  const short =
    abs >= 1e9
      ? `${(value / 1e9).toFixed(1)}G`
      : abs >= 1e6
        ? `${(value / 1e6).toFixed(1)}M`
        : abs >= 1e4
          ? `${(value / 1e3).toFixed(1)}k`
          : Number.isInteger(value)
            ? String(value)
            : value.toFixed(abs < 10 ? 2 : 1);
  return unit ? `${short} ${unit}${suffix}` : `${short}${suffix}`;
}
