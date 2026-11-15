/**
 * The «Calc» and «Grouping» panels of the grid: figures of the cells selected, and the
 * values of some columns with how many times each one appears among the rows loaded.
 */
import { cellText, isNull } from '../results';
import { classOf } from './cells';

export interface CalcFigures {
  count: number;
  distinct: number;
  nulls: number;
  /** Over the numbers only; none when there is none. */
  sum?: number;
  average?: number;
  min?: string;
  max?: string;
}

const numeric = (value: unknown) =>
  typeof value === 'number' ? value : Number((value as { v?: unknown })?.v);

export function calculate(values: readonly unknown[]): CalcFigures {
  const present = values.filter((value) => !isNull(value));
  const numbers = present.filter((value) => classOf(value) === 'number').map(numeric);
  const texts = present.map(cellText);
  const sorted =
    numbers.length === present.length && numbers.length
      ? [...numbers].sort((a, b) => a - b).map(String)
      : [...texts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const sum = numbers.reduce((total, number) => total + number, 0);
  return {
    count: values.length,
    distinct: new Set(texts).size,
    nulls: values.length - present.length,
    ...(numbers.length ? { sum, average: sum / numbers.length } : {}),
    ...(sorted.length ? { min: sorted[0], max: sorted.at(-1) } : {}),
  };
}

export interface Group {
  values: string[];
  count: number;
}

/** The distinct values of some columns among the rows loaded, most frequent first. */
export function groupRows(rows: readonly unknown[][], columns: readonly number[]): Group[] {
  const counts = new Map<string, Group>();
  for (const row of rows) {
    const values = columns.map((column) => cellText(row[column]));
    const key = JSON.stringify(values);
    const group = counts.get(key);
    if (group) group.count++;
    else counts.set(key, { values, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.values.join().localeCompare(b.values.join()),
  );
}
