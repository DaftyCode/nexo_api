/**
 * How the database section draws what drivers describe: the icon of each node of the tree and
 * of each view of an object, the badge of a result column by its class, and counts written
 * short («200K») where room is scarce.
 */
import { ResultColumn } from './results';
import { DbNode } from './tree';

/** The icon of a node by its class; folders by what they hold. */
const NODE_ICONS: Record<string, string> = {
  database: 'databases',
  schema: 'cube',
  table: 'table',
  view: 'view',
  column: 'column',
  constraint: 'key',
  index: 'bars',
  function: 'function',
  procedure: 'procedure',
  aggregate: 'function',
  sequence: 'sequence',
  trigger: 'trigger',
  role: 'role',
  rule: 'rule',
  policy: 'policy',
  dependency: 'dependency',
  extension: 'dependency',
  tablespace: 'partition',
};

const FOLDER_ICONS: Record<string, string> = {
  databases: 'databases',
  schemas: 'cube',
  views: 'view',
  'materialized-views': 'view',
  functions: 'function',
  aggregates: 'function',
  procedures: 'procedure',
  sequences: 'sequence',
  columns: 'column',
  constraints: 'key',
  'foreign-keys': 'link',
  indexes: 'bars',
  dependencies: 'dependency',
  references: 'reference',
  partitions: 'partition',
  triggers: 'trigger',
  rules: 'rule',
  policies: 'policy',
  roles: 'role',
  logins: 'role',
};

export function nodeIcon(node: Pick<DbNode, 'kind' | 'name'>): string {
  if (node.kind === 'folder') return FOLDER_ICONS[node.name] ?? 'folder';
  return NODE_ICONS[node.kind] ?? 'datasets';
}

/** The icon of a view of an object's tab: data, properties, a section of the driver, DDL. */
export function partIcon(part: string): string {
  if (part === 'data') return 'table';
  if (part === 'properties') return 'info';
  if (part === 'ddl') return 'code';
  return FOLDER_ICONS[part] ?? 'rule';
}

/** What heads a column: an icon, or a short text such as `Aa` for text. */
export interface ColumnBadge {
  icon?: string;
  glyph?: string;
}

/** The badge of a result column: its key, what its name says it holds, or its class. */
export function columnBadge(column: Pick<ResultColumn, 'name' | 'kind' | 'key'>): ColumnBadge {
  if (column.key) return { icon: 'key' };
  const name = column.name.toLowerCase();
  if (/(^|_)e?mail($|_)/.test(name)) return { icon: 'mail' };
  if (/pass(word)?|secret|hash|token/.test(name)) return { icon: 'lock' };
  switch (column.kind) {
    case 'integer':
    case 'decimal':
    case 'float':
      return { glyph: '#' };
    case 'boolean':
      return { icon: 'toggle' };
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestamptz':
      return { icon: 'calendar' };
    case 'json':
      return { icon: 'body' };
    case 'binary':
      return { icon: 'binary' };
    case 'uuid':
      return { glyph: 'ID' };
    default:
      return { glyph: 'Aa' };
  }
}

/** A count written short: 950, 1.2K, 24K, 1.5M. */
export function compactCount(count: number): string {
  const units: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units)
    if (count >= size) {
      const value = count / size;
      return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${unit}`;
    }
  return String(Math.max(0, Math.round(count)));
}

/** The rows a driver estimates for a table, from the detail it gives in the tree. */
export function detailRows(detail: string | undefined): number | undefined {
  const found = /^~?(\d+) rows$/.exec(detail ?? '');
  return found ? Number(found[1]) : undefined;
}
