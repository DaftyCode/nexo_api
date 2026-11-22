/**
 * Where the canvas of the visual query builder draws each table of a model (a grid, in the
 * order they were added) and the line of each comparison of a join, from the row of one
 * column to the row of the other. Units are the canvas' own, which the styles scale.
 */
import type { QueryModel } from '../query-model';
import type { BuilderTable } from './edit';

/**
 * The sizes of the canvas. A table is as wide as its text (`char` per character and `padding`
 * for its box, check boxes and button), from `width` to `maxWidth`.
 */
export const BOX = {
  width: 200,
  maxWidth: 420,
  char: 7.5,
  padding: 56,
  header: 28,
  row: 22,
  gapX: 60,
  gapY: 40,
  perRow: 3,
} as const;

/** The width of a table's box: its name and alias, or its longest column. */
export function boxWidth(label: string, alias: string, columns: readonly string[]): number {
  const longest = Math.max(label.length + alias.length, ...columns.map((name) => name.length));
  return Math.round(Math.min(BOX.maxWidth, Math.max(BOX.width, longest * BOX.char + BOX.padding)));
}

export interface LaidColumn {
  name: string;
  /** The expression that names it, by the table's alias. */
  expression: string;
  y: number;
}
export interface LaidTable {
  index: number;
  alias: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: LaidColumn[];
}
export interface LaidLine {
  /** The table whose join it is. */
  table: number;
  kind: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface BuilderLayout {
  tables: LaidTable[];
  lines: LaidLine[];
  width: number;
  height: number;
}

/** The table of the builder a table of the model is, by its name and schema. */
export function knownTable(
  table: QueryModel['tables'][number],
  known: readonly BuilderTable[],
): BuilderTable | undefined {
  const [name, schema] = [table.path.at(-1), table.path.at(-2)];
  return known.find(
    (each) =>
      each.name.toLowerCase() === name?.toLowerCase() &&
      (!schema || !each.schema || each.schema.toLowerCase() === schema.toLowerCase()),
  );
}

/** Takes the quotes off one part of an expression: `"Order Lines"` is `Order Lines`. */
const bare = (part: string) => part.replace(/^["`[]|["`\]]$/g, '');

export function builderLayout(
  model: QueryModel,
  known: readonly BuilderTable[],
  expressionOf: (alias: string, column: string) => string,
): BuilderLayout {
  const tables: LaidTable[] = [];
  let height = 0;
  const rowHeights: number[] = [];
  // Where the next table of each row starts, as wide as the ones before it.
  const rowEnds: number[] = [];
  for (const [index, table] of model.tables.entries()) {
    const columns = knownTable(table, known)?.columns ?? [];
    const row = Math.floor(index / BOX.perRow);
    const boxHeight = BOX.header + Math.max(columns.length, 1) * BOX.row;
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, boxHeight);
    const y = rowHeights.slice(0, row).reduce((sum, each) => sum + each + BOX.gapY, 0);
    const alias = table.alias || (table.path.at(-1) ?? '');
    const label = table.path.join('.');
    const width = boxWidth(label, alias, columns);
    const x = rowEnds[row] ?? 0;
    rowEnds[row] = x + width + BOX.gapX;
    tables.push({
      index,
      alias,
      label,
      x,
      y,
      width,
      height: boxHeight,
      columns: columns.map((name, at) => ({
        name,
        expression: expressionOf(alias, name),
        y: y + BOX.header + at * BOX.row + BOX.row / 2,
      })),
    });
    height = Math.max(height, y + boxHeight);
  }
  // Where an expression of a join is drawn from: its column's row, or the table's header.
  const anchor = (expression: string) => {
    const parts = expression.split('.').map(bare);
    const alias = parts.at(-2) ?? '';
    const column = parts.at(-1) ?? '';
    const table = tables.find((each) => each.alias === alias);
    if (!table) return undefined;
    const row = table.columns.find((each) => each.name === column);
    return { table, y: row?.y ?? table.y + BOX.header / 2 };
  };
  const lines: LaidLine[] = [];
  for (const join of model.joins)
    for (const comparison of join.on) {
      const [from, to] = [anchor(comparison.left), anchor(comparison.right)];
      if (!from || !to || from.table === to.table) continue;
      const leftFirst = from.table.x <= to.table.x;
      const [a, b] = leftFirst ? [from, to] : [to, from];
      const sameColumn = a.table.x === b.table.x;
      lines.push({
        table: join.table,
        kind: join.kind,
        x1: a.table.x + (sameColumn ? 0 : a.table.width),
        y1: a.y,
        x2: b.table.x,
        y2: b.y,
      });
    }
  return {
    tables,
    lines,
    width: Math.max(BOX.width, ...rowEnds.map((end) => end - BOX.gapX)),
    height: Math.max(height, BOX.header),
  };
}
