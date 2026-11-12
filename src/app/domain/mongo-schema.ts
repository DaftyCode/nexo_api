/**
 * The schema of a collection as the engine analyses it from a sample: each field path with
 * its presence, types, frequent values and anomalies. Here it becomes the paths a query
 * names, the filter of a value, a CSV or Markdown table, and the field names suggested while
 * a query is typed.
 */

import { isPlain, shell } from './bson';
import { csvRow } from './mongo-transfer';

export interface TypeSummary {
  name: string;
  count: number;
  min?: unknown;
  max?: unknown;
  lengths?: { min: number; max: number; average: number };
}

export type SchemaAnomaly = 'mixedTypes' | 'sometimesMissing';

export interface FieldSchema {
  /** Dotted, with `[]` for the items of an array (`items.[].sku`). */
  path: string;
  name: string;
  depth: number;
  count: number;
  parents: number;
  types: TypeSummary[];
  values: { value: unknown; count: number }[];
  distinct: number;
  distinctCapped: boolean;
  anomalies: SchemaAnomaly[];
}

export interface SchemaReport {
  sampled: number;
  fields: FieldSchema[];
  truncated: boolean;
  elapsedMs: number;
  /** A MongoDB validator: `{$jsonSchema: …}`. */
  validator: Record<string, unknown>;
  /** JSON Schema draft 2020-12. */
  jsonSchema: Record<string, unknown>;
}

/** Documents a sample may have. */
export const SAMPLE_SIZES = ['100', '1000', '5000', '10000'];

/** Share of a whole, from 0 to 100, with one decimal at most. */
export function percent(count: number, of: number): number {
  return of ? Math.round((count / of) * 1000) / 10 : 0;
}

/** The share of documents (or of embedded documents) where a field is present. */
export function presence(field: FieldSchema): number {
  return percent(field.count, field.parents);
}

/** The path a query names: the items of an array are reached through the array. */
export function queryPath(path: string): string {
  return path
    .split('.')
    .filter((segment) => segment !== '[]')
    .join('.');
}

/** A filter that finds the documents with this value in the field, in the shell syntax. */
export function valueFilter(field: FieldSchema, value: unknown): string {
  return `{ ${JSON.stringify(queryPath(field.path))}: ${shell(value)} }`;
}

/** A value as one short line, in the shell syntax. */
export function valueText(value: unknown): string {
  const text = shell(value).replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const typeShares = (field: FieldSchema) =>
  field.types.map((type) => `${type.name} ${percent(type.count, field.count)}%`).join(', ');
const topValues = (field: FieldSchema) =>
  field.values.map((entry) => `${valueText(entry.value)} (${entry.count})`).join(', ');

/** The schema as CSV: one row per field. */
export function schemaCsv(report: SchemaReport): string {
  const rows = [
    csvRow(['field', 'presence %', 'types', 'anomalies', 'distinct values', 'frequent values']),
    ...report.fields.map((field) =>
      csvRow([
        field.path,
        String(presence(field)),
        typeShares(field),
        field.anomalies.join(', '),
        `${field.distinct}${field.distinctCapped ? '+' : ''}`,
        topValues(field),
      ]),
    ),
  ];
  return `${rows.join('\n')}\n`;
}

/** The schema as a Markdown document: a title, the sample and a table of the fields. */
export function schemaMarkdown(report: SchemaReport, title: string): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# ${title}`,
    '',
    `${report.sampled} documents sampled.`,
    '',
    '| Field | Presence | Types | Anomalies |',
    '| --- | --- | --- | --- |',
    ...report.fields.map(
      (field) =>
        `| ${cell(field.path)} | ${presence(field)}% | ${cell(typeShares(field))} | ${field.anomalies.join(', ')} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The field paths a query can name, for suggestions while it is typed: those of the schema,
 * then those of the documents shown.
 */
export function fieldNames(
  report: SchemaReport | undefined,
  documents: readonly unknown[] = [],
): string[] {
  const names = new Set<string>();
  for (const field of report?.fields ?? [])
    if (field.name !== '[]') names.add(queryPath(field.path));
  const visit = (value: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, inner] of Object.entries(value)) {
      names.add(prefix + key);
      const wrapper = Object.keys(isPlain(inner) ? inner : {}).some((name) => name.startsWith('$'));
      if (isPlain(inner) && !wrapper && depth < 10) visit(inner, `${prefix}${key}.`, depth + 1);
    }
  };
  for (const document of documents) if (isPlain(document)) visit(document, '', 0);
  return [...names];
}
