/**
 * The chart of a result (DB-28), as DBeaver's: a column for the X axis and numeric columns as
 * series, or one series per value of another column; repeated X values aggregated; the
 * categories ordered and the last ones gathered as «the rest». Chosen on its own the first
 * time (a date gives lines, a text bars) and kept with the script, by statement. It works on
 * the rows the grid has loaded. The geometry is in `result-chart/geometry.ts`.
 */
import { ChartAggregate, ResultChartConfig } from './result-chart/config';
import { ResultColumn, cellText, isNull } from './results';

export * from './result-chart/config';

export type XKind = 'date' | 'number' | 'text';
export interface ChartCategory {
  label: string;
  /** Where it goes on a continuous axis: a time, a number, or its place. */
  at: number;
  /** The categories gathered past the limit. */
  rest?: boolean;
}
export interface ChartData {
  xKind: XKind;
  categories: ChartCategory[];
  series: { name: string; values: (number | null)[] }[];
}

const NUMERIC = ['integer', 'decimal', 'float', 'number'];
const TEMPORAL = ['date', 'timestamp', 'timestamptz', 'datetime'];
const kindOf = (column: ResultColumn | undefined): XKind =>
  !column
    ? 'text'
    : TEMPORAL.includes(column.kind)
      ? 'date'
      : NUMERIC.includes(column.kind)
        ? 'number'
        : 'text';

/** A cell as a number, when it is one. */
export function numberOf(value: unknown): number | null {
  if (isNull(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = typeof value === 'string' ? value : cellText(value);
  const number = Number(text.trim());
  return text.trim() && Number.isFinite(number) ? number : null;
}

/** The chart a result gets the first time: dates as lines, texts as bars, numbers as series. */
export function autoChart(columns: readonly ResultColumn[]): ResultChartConfig {
  const x =
    columns.find((column) => kindOf(column) === 'date') ??
    columns.find((column) => kindOf(column) === 'text') ??
    columns[0];
  const y = columns
    .filter((column) => column !== x && kindOf(column) === 'number')
    .slice(0, 6)
    .map((column) => column.name);
  const xKind = kindOf(x);
  return {
    type: xKind === 'date' ? 'line' : xKind === 'number' && y.length ? 'scatter' : 'bar',
    x: x?.name ?? '',
    y,
    group: '',
    aggregate: y.length ? 'sum' : 'count',
    order: 'x',
    limit: xKind === 'text' ? 20 : 0,
    log: false,
    title: '',
    xLabel: '',
    yLabel: '',
  };
}

function aggregate(values: readonly number[], how: ChartAggregate): number | null {
  if (how === 'count') return values.length;
  if (!values.length) return null;
  switch (how) {
    case 'sum':
      return values.reduce((sum, each) => sum + each, 0);
    case 'avg':
      return values.reduce((sum, each) => sum + each, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

/** Where a value of the X column goes: its time, its number, or none (its place). */
function position(value: unknown, kind: XKind): number | undefined {
  if (kind === 'number') return numberOf(value) ?? undefined;
  if (kind === 'date') {
    const time = Date.parse(cellText(value).replace(' ', 'T'));
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

/** The categories and series of a chart, from the rows loaded. */
export function chartData(
  config: ResultChartConfig,
  columns: readonly ResultColumn[],
  rows: readonly (readonly unknown[])[],
): ChartData {
  const at = (name: string) => columns.findIndex((column) => column.name === name);
  const xIndex = at(config.x);
  const xKind = kindOf(columns[xIndex]);
  const ys = config.y.map((name) => ({ name, index: at(name) })).filter((y) => y.index >= 0);
  const groupIndex = config.group ? at(config.group) : -1;
  const how: ChartAggregate = ys.length ? config.aggregate : 'count';
  const measures = ys.length ? ys : [{ name: 'count', index: -1 }];
  // Values gathered by category and series.
  const categories = new Map<string, { label: string; at?: number; order: number }>();
  const names: string[] = [];
  const values = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const x = xIndex >= 0 ? row[xIndex] : null;
    const label = isNull(x) ? 'NULL' : cellText(x);
    if (!categories.has(label))
      categories.set(label, { label, at: position(x, xKind), order: categories.size });
    const group =
      groupIndex >= 0 ? (isNull(row[groupIndex]) ? 'NULL' : cellText(row[groupIndex])) : '';
    for (const measure of measures) {
      const name = group
        ? measures.length > 1
          ? `${group} · ${measure.name}`
          : group
        : measure.name;
      if (!names.includes(name)) names.push(name);
      const value = measure.index < 0 ? 1 : numberOf(row[measure.index]);
      const byName = values.get(label) ?? new Map<string, number[]>();
      const list = byName.get(name) ?? [];
      if (value !== null) list.push(value);
      byName.set(name, list);
      values.set(label, byName);
    }
  }
  const total = (label: string) =>
    names.reduce((sum, name) => sum + (aggregate(values.get(label)?.get(name) ?? [], how) ?? 0), 0);
  const ordered = [...categories.values()];
  if (config.order === 'x' && xKind !== 'text')
    ordered.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  else if (config.order !== 'x')
    ordered.sort((a, b) =>
      config.order === 'desc' ? total(b.label) - total(a.label) : total(a.label) - total(b.label),
    );
  const shown =
    config.limit > 0 && config.type !== 'scatter' ? ordered.slice(0, config.limit) : ordered;
  const rest = config.limit > 0 && config.type !== 'scatter' ? ordered.slice(config.limit) : [];
  const result: ChartData = {
    xKind,
    categories: shown.map((each, index) => ({ label: each.label, at: each.at ?? index })),
    series: names.map((name) => ({
      name,
      values: shown.map((each) => aggregate(values.get(each.label)?.get(name) ?? [], how)),
    })),
  };
  if (rest.length) {
    result.categories.push({ label: '', at: shown.length, rest: true });
    for (const series of result.series)
      series.values.push(
        aggregate(
          rest.flatMap((each) => values.get(each.label)?.get(series.name) ?? []),
          how,
        ),
      );
  }
  return result;
}
