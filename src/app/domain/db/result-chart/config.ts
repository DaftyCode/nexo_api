/**
 * The settings of a result's chart (DB-28) as they are kept with a script or a draft: read
 * apart from the charts themselves, so a session reads them without loading the charts.
 */
export type ChartType = 'line' | 'area' | 'bar' | 'hbar' | 'stacked' | 'pie' | 'scatter';
export const CHART_TYPES: readonly ChartType[] = [
  'line',
  'area',
  'bar',
  'hbar',
  'stacked',
  'pie',
  'scatter',
];
export type ChartAggregate = 'sum' | 'avg' | 'count' | 'min' | 'max';
export const CHART_AGGREGATES: readonly ChartAggregate[] = ['sum', 'avg', 'count', 'min', 'max'];
export type ChartOrder = 'x' | 'desc' | 'asc';

export interface ResultChartConfig {
  type: ChartType;
  x: string;
  y: string[];
  /** A column whose values each make a series. */
  group: string;
  aggregate: ChartAggregate;
  order: ChartOrder;
  /** Categories shown at most, the rest gathered in one; 0 shows them all. */
  limit: number;
  log: boolean;
  title: string;
  xLabel: string;
  yLabel: string;
}

/** A stored chart, or none when it is not one. */
export function readChartConfig(value: unknown): ResultChartConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const text = (key: string) => (typeof source[key] === 'string' ? (source[key] as string) : '');
  const type = CHART_TYPES.find((each) => each === source['type']);
  if (!type || !text('x')) return undefined;
  const limit = Number(source['limit']);
  return {
    type,
    x: text('x'),
    y: Array.isArray(source['y'])
      ? source['y'].filter((each): each is string => typeof each === 'string')
      : [],
    group: text('group'),
    aggregate: CHART_AGGREGATES.find((each) => each === source['aggregate']) ?? 'sum',
    order: source['order'] === 'desc' || source['order'] === 'asc' ? source['order'] : 'x',
    limit: Number.isInteger(limit) && limit >= 0 && limit <= 1000 ? limit : 0,
    log: source['log'] === true,
    title: text('title'),
    xLabel: text('xLabel'),
    yLabel: text('yLabel'),
  };
}

/** The charts kept with a script or a draft, as `{charts}` when there are any. */
export function readCharts(value: unknown): { charts?: Record<string, ResultChartConfig> } {
  if (!value || typeof value !== 'object') return {};
  const charts = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .flatMap(([key, chart]) => {
        const read = readChartConfig(chart);
        return read ? [[key, read]] : [];
      }),
  );
  return Object.keys(charts).length ? { charts } : {};
}

/** The key a chart is kept by in its script: the statement with its spaces collapsed. */
export const chartKey = (sql: string) => sql.trim().replace(/\s+/g, ' ').slice(0, 2000);
