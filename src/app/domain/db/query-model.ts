/**
 * The model of the visual query builder (DB-26): the tables of a `SELECT` with their aliases,
 * the joins between them, the columns chosen (with an alias and an aggregate), the conditions
 * of `WHERE` and `HAVING` in groups of «all» or «any», the grouping, the order and the page.
 * The engine reads a `SELECT` into it (`db.query.parse`) and says what it cannot hold; the
 * builder writes SQL from it (`query-model/sql.ts`) and edits it (`query-model/edit.ts`).
 * Expressions are SQL text, as they are written.
 */
export type JoinKind = 'inner' | 'left' | 'right' | 'full';
export const JOIN_KINDS: readonly JoinKind[] = ['inner', 'left', 'right', 'full'];
export type Comparison = '=' | '<>' | '<' | '<=' | '>' | '>=';
export const COMPARISONS: readonly Comparison[] = ['=', '<>', '<', '<=', '>', '>='];
export type Aggregate = '' | 'count' | 'count-distinct' | 'sum' | 'avg' | 'min' | 'max';
export const AGGREGATES: readonly Aggregate[] = [
  '',
  'count',
  'count-distinct',
  'sum',
  'avg',
  'min',
  'max',
];
export type ConditionOperator =
  | Comparison
  | 'like'
  | 'not like'
  | 'in'
  | 'not in'
  | 'between'
  | 'not between'
  | 'is null'
  | 'is not null';
export const CONDITION_OPERATORS: readonly ConditionOperator[] = [
  ...COMPARISONS,
  'like',
  'not like',
  'in',
  'not in',
  'between',
  'not between',
  'is null',
  'is not null',
];
/** How many values an operator takes; `in` takes one or more. */
export const operatorValues = (operator: ConditionOperator): number =>
  operator.endsWith('null') ? 0 : operator.endsWith('between') ? 2 : 1;

export interface QueryTable {
  /** Its name in parts (`schema`, `table`), unquoted. */
  path: string[];
  alias: string;
}
export interface JoinComparison {
  left: string;
  operator: Comparison;
  right: string;
}
export interface QueryJoin {
  /** The table it joins, by its place in `tables` (never the first). */
  table: number;
  kind: JoinKind;
  on: JoinComparison[];
}
export interface QueryColumn {
  expression: string;
  alias: string;
  aggregate: Aggregate;
}
/** Text is written as a string of the dialect; a number and an expression, as they are. */
export type ValueKind = 'text' | 'number' | 'expression';
export interface ConditionValue {
  text: string;
  kind: ValueKind;
}
export interface Condition {
  column: string;
  operator: ConditionOperator;
  values: ConditionValue[];
}
export interface ConditionGroup {
  match: 'all' | 'any';
  items: (Condition | ConditionGroup)[];
}
export interface QueryOrder {
  expression: string;
  descending: boolean;
}
export interface QueryModel {
  distinct: boolean;
  tables: QueryTable[];
  joins: QueryJoin[];
  columns: QueryColumn[];
  where: ConditionGroup | null;
  groupBy: string[];
  having: ConditionGroup | null;
  orderBy: QueryOrder[];
  limit: number | null;
  offset: number | null;
}

export const isGroup = (item: Condition | ConditionGroup): item is ConditionGroup =>
  'match' in item;

export function emptyQuery(): QueryModel {
  return {
    distinct: false,
    tables: [],
    joins: [],
    columns: [],
    where: null,
    groupBy: [],
    having: null,
    orderBy: [],
    limit: null,
    offset: null,
  };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
const one = <T extends string>(value: unknown, known: readonly T[], otherwise: T): T =>
  known.includes(value as T) ? (value as T) : otherwise;

function readGroup(value: unknown): ConditionGroup | null {
  if (!value || typeof value !== 'object') return null;
  const group = record(value);
  return {
    match: group['match'] === 'any' ? 'any' : 'all',
    items: list(group['items']).map((item) => {
      const each = record(item);
      if ('match' in each) return readGroup(each) ?? { match: 'all', items: [] };
      return {
        column: text(each['column']),
        operator: one(each['operator'], CONDITION_OPERATORS, '='),
        values: list(each['values']).map((v) => ({
          text: text(record(v)['text']),
          kind: one(record(v)['kind'], ['text', 'number', 'expression'] as const, 'text'),
        })),
      };
    }),
  };
}

/** What `db.query.parse` answers: the model, or why there is none. */
export type ParsedQuery = { model: QueryModel } | { unsupported: string };

export function readParsedQuery(answer: unknown): ParsedQuery {
  const value = record(answer);
  if (typeof value['unsupported'] === 'string') return { unsupported: value['unsupported'] };
  const model = record(value['model']);
  return {
    model: {
      distinct: model['distinct'] === true,
      tables: list(model['tables']).map((table) => ({
        path: list(record(table)['path']).map(text),
        alias: text(record(table)['alias']),
      })),
      joins: list(model['joins']).map((join) => ({
        table: count(record(join)['table']) ?? 1,
        kind: one(record(join)['kind'], JOIN_KINDS, 'inner'),
        on: list(record(join)['on']).map((each) => ({
          left: text(record(each)['left']),
          operator: one(record(each)['operator'], COMPARISONS, '='),
          right: text(record(each)['right']),
        })),
      })),
      columns: list(model['columns']).map((column) => ({
        expression: text(record(column)['expression']),
        alias: text(record(column)['alias']),
        aggregate: one(record(column)['aggregate'], AGGREGATES, ''),
      })),
      where: readGroup(model['where']),
      groupBy: list(model['groupBy']).map(text),
      having: readGroup(model['having']),
      orderBy: list(model['orderBy']).map((order) => ({
        expression: text(record(order)['expression']),
        descending: record(order)['descending'] === true,
      })),
      limit: count(model['limit']),
      offset: count(model['offset']),
    },
  };
}
