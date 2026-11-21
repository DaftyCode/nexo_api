/**
 * Comparing two databases (DB-24): what the backend answers of their structure and their
 * data, and what the interface needs to show it (the two DDLs line by line, a table's schema
 * and name from its path).
 */

export type CompareStatus = 'equal' | 'equivalent' | 'different' | 'onlySource' | 'onlyTarget';
export const COMPARE_STATUSES: readonly CompareStatus[] = [
  'different',
  'onlySource',
  'onlyTarget',
  'equivalent',
  'equal',
];

/** What a comparison starts from: a schema or database, a whole SQLite file, or a table. */
export type CompareKind = 'schema' | 'table';

/** A part of a table that differs, and the fields of it that do. */
export interface PartDifference {
  part: string;
  name: string;
  status: CompareStatus;
  fields: string[];
  source: Record<string, unknown> | null;
  target: Record<string, unknown> | null;
}

export interface ComparedObject {
  kind: string;
  name: string;
  status: CompareStatus;
  sourcePath?: string[] | null;
  targetPath?: string[] | null;
  differences: PartDifference[];
  sourceDefinition?: string;
  targetDefinition?: string;
}

export interface SchemaComparison {
  between: boolean;
  objects: ComparedObject[];
  counts: Record<CompareStatus, number>;
}

export interface RowDifference {
  kind: 'onlySource' | 'onlyTarget' | 'different';
  key: unknown[];
  source: unknown[] | null;
  target: unknown[] | null;
  columns: string[];
}

export interface DataComparison {
  counts: { onlySource: number; onlyTarget: number; different: number; equal: number };
  key: string[];
  columns: string[];
  differences: RowDifference[];
  complete: boolean;
}

const statuses = new Set<string>(COMPARE_STATUSES);

export function readSchemaComparison(value: unknown): SchemaComparison {
  const answer = (value ?? {}) as Partial<SchemaComparison>;
  const objects = (Array.isArray(answer.objects) ? answer.objects : []).filter((object) =>
    statuses.has(String(object?.status)),
  );
  const counts = Object.fromEntries(
    COMPARE_STATUSES.map((status) => [status, Number(answer.counts?.[status] ?? 0)]),
  ) as Record<CompareStatus, number>;
  return {
    between: !!answer.between,
    objects: objects.map((object) => ({
      ...object,
      differences: Array.isArray(object.differences) ? object.differences : [],
    })),
    counts,
  };
}

export function readDataComparison(value: unknown): DataComparison {
  const answer = (value ?? {}) as Partial<DataComparison>;
  const count = (key: keyof DataComparison['counts']) => Number(answer.counts?.[key] ?? 0);
  return {
    counts: {
      onlySource: count('onlySource'),
      onlyTarget: count('onlyTarget'),
      different: count('different'),
      equal: count('equal'),
    },
    key: Array.isArray(answer.key) ? answer.key.map(String) : [],
    columns: Array.isArray(answer.columns) ? answer.columns.map(String) : [],
    differences: Array.isArray(answer.differences) ? answer.differences : [],
    complete: answer.complete !== false,
  };
}

/** A warning of the script that makes the target like the source: a text of the catalogs. */
export interface CompareWarning {
  text: string;
  params: Record<string, string>;
}

/** The warnings of a script, as the backend sends them (a text, or a text and its values). */
export function readWarnings(value: unknown): CompareWarning[] {
  return (Array.isArray(value) ? value : []).flatMap((each): CompareWarning[] => {
    if (typeof each === 'string') return [{ text: each, params: {} }];
    const read = (each ?? {}) as { text?: unknown; params?: unknown };
    if (typeof read.text !== 'string') return [];
    const params = Object.fromEntries(
      Object.entries((read.params ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k,
        String(v),
      ]),
    );
    return [{ text: read.text, params }];
  });
}

/** Whether two sides have nothing to change: every object equal or equivalent. */
export function alike(comparison: SchemaComparison): boolean {
  return comparison.objects.every((object) => ['equal', 'equivalent'].includes(object.status));
}

/** A table's schema (or MySQL database) and name, from its path in the tree. */
export function tableOf(path: readonly string[]): { schema?: string; table: string } {
  const table = path.at(-1) ?? '';
  const schema = path.length >= 3 ? path.at(-3) : undefined;
  return schema ? { schema, table } : { table };
}

/** A line of two definitions side by side, and whether the other side has it. */
export interface DefinitionLine {
  text: string;
  changed: boolean;
}

/** The lines of each definition, those the other one lacks marked (spaces at the ends left out). */
export function definitionLines(
  source: string,
  target: string,
): [DefinitionLine[], DefinitionLine[]] {
  const lines = (text: string) => text.split(/\r?\n/);
  // A line is the same with or without the comma that ends it in a list.
  const bare = (line: string) => line.trim().replace(/,$/, '');
  const set = (text: string) => new Set(lines(text).map(bare));
  const [a, b] = [set(source), set(target)];
  const mark = (text: string, other: Set<string>) =>
    lines(text).map((line) => ({ text: line, changed: !other.has(bare(line)) }));
  return [mark(source, b), mark(target, a)];
}

/** A value of a row as shown: text as it is, typed values by their text, null as NULL. */
export function shownValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object' && 'v' in (value as Record<string, unknown>))
    return String((value as { v: unknown }).v);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The text of a list of names typed with commas. */
export function namesOf(text: string): string[] {
  return text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}
