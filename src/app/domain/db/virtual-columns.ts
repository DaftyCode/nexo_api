/**
 * Virtual columns, as DBeaver's: a column computed in the interface from the others of each
 * row with a simple expression, only to be seen (never saved in the database). The
 * expression has numbers, 'texts', the names of columns (bare or "quoted"), + - * / for
 * numbers, || to join texts, and parentheses. Nothing else is read, so nothing else runs.
 */
import { ResultColumn, cellText, isNull } from './results';

export interface VirtualColumn {
  name: string;
  expression: string;
}

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'column'; name: string }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'negate'; operand: Node };

const TOKEN =
  /\s*(?:(\d+(?:\.\d+)?)|'((?:[^']|'')*)'|"((?:[^"]|"")*)"|([A-Za-z_][\w$]*)|(\|\||[-+*/()]))/y;

function tokens(expression: string): string[][] {
  const found: string[][] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expression.length) {
    if (!expression.slice(TOKEN.lastIndex).trim()) break;
    const match = TOKEN.exec(expression);
    if (!match) throw new Error('db.virtual.invalid');
    found.push(match);
  }
  return found;
}

/** Reads an expression; throws `db.virtual.invalid` when it is not one. */
export function parseExpression(expression: string): Node {
  const list = tokens(expression);
  let at = 0;
  const peek = () => list[at]?.[5];
  const primary = (): Node => {
    const token = list[at++];
    if (!token) throw new Error('db.virtual.invalid');
    if (token[1] !== undefined) return { kind: 'number', value: Number(token[1]) };
    if (token[2] !== undefined) return { kind: 'text', value: token[2].replaceAll("''", "'") };
    if (token[3] !== undefined) return { kind: 'column', name: token[3].replaceAll('""', '"') };
    if (token[4] !== undefined) return { kind: 'column', name: token[4] };
    if (token[5] === '-') return { kind: 'negate', operand: primary() };
    if (token[5] === '(') {
      const inner = sum();
      if (list[at++]?.[5] !== ')') throw new Error('db.virtual.invalid');
      return inner;
    }
    throw new Error('db.virtual.invalid');
  };
  const product = (): Node => {
    let left = primary();
    while (peek() === '*' || peek() === '/')
      left = { kind: 'binary', operator: list[at++][5], left, right: primary() };
    return left;
  };
  const sum = (): Node => {
    let left = product();
    while (peek() === '+' || peek() === '-' || peek() === '||')
      left = { kind: 'binary', operator: list[at++][5], left, right: product() };
    return left;
  };
  const node = sum();
  if (at !== list.length) throw new Error('db.virtual.invalid');
  return node;
}

/** The names of the columns an expression reads. */
export function columnsOf(node: Node): string[] {
  if (node.kind === 'column') return [node.name];
  if (node.kind === 'binary') return [...columnsOf(node.left), ...columnsOf(node.right)];
  if (node.kind === 'negate') return columnsOf(node.operand);
  return [];
}

/** The value of an expression for a row: `null` when a value it needs is missing or not a number. */
export function evaluate(node: Node, value: (name: string) => unknown): unknown {
  switch (node.kind) {
    case 'number':
    case 'text':
      return node.value;
    case 'column': {
      const found = value(node.name);
      if (isNull(found)) return null;
      const text = cellText(found);
      return typeof found === 'number' ? found : text;
    }
    case 'negate': {
      const operand = Number(evaluate(node.operand, value));
      return Number.isFinite(operand) ? -operand : null;
    }
    case 'binary': {
      const left = evaluate(node.left, value);
      const right = evaluate(node.right, value);
      if (left === null || right === null) return null;
      if (node.operator === '||') return `${left}${right}`;
      const [a, b] = [Number(left), Number(right)];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const result = { '+': a + b, '-': a - b, '*': a * b, '/': b === 0 ? NaN : a / b }[
        node.operator
      ];
      return result === undefined || !Number.isFinite(result)
        ? null
        : Math.round(result * 1e10) / 1e10;
    }
  }
}

/** The columns and rows with the virtual columns after them. */
export function withVirtualColumns(
  columns: readonly ResultColumn[],
  rows: readonly (readonly unknown[])[],
  virtual: readonly VirtualColumn[],
): { columns: ResultColumn[]; rows: unknown[][] } {
  const parsed = virtual.flatMap((column) => {
    try {
      return [{ column, node: parseExpression(column.expression) }];
    } catch {
      return [];
    }
  });
  const index = new Map(columns.map((column, at) => [column.name.toLowerCase(), at]));
  return {
    columns: [
      ...columns,
      ...parsed.map(({ column }) => ({ name: column.name, typeName: 'virtual', kind: 'other' })),
    ],
    rows: rows.map((row) => [
      ...row,
      ...parsed.map(({ node }) =>
        evaluate(node, (name) => {
          const at = index.get(name.toLowerCase());
          return at === undefined ? null : row[at];
        }),
      ),
    ]),
  };
}
