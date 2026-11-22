/**
 * The SQL of a query model, in the dialect of its connection: names quoted as it quotes them,
 * values of conditions as its literals (escaped: a quote in a value never ends the string),
 * and the page with its syntax (`LIMIT`/`OFFSET`, or `TOP` and `OFFSET … FETCH` in SQL
 * Server). The text is laid out the same way every time, a clause per line.
 */
import { SqlStyle } from '../grid/copy';
import { quoteName } from '../tree';
import {
  Condition,
  ConditionGroup,
  ConditionValue,
  QueryColumn,
  QueryModel,
  isGroup,
  operatorValues,
} from '../query-model';

const tsql = (style: SqlStyle) => style.name === 'tsql';
/** The limit that keeps every row, where a page skips rows only after a limit. */
const REST = { mysql: '18446744073709551615', sqlite: '-1' };

/** A text as a string literal of the dialect. */
export function textLiteral(text: string, style: SqlStyle): string {
  let escaped = text.replace(/'/g, "''");
  if (style.name === 'mysql') escaped = escaped.replace(/\\/g, '\\\\');
  // SQL Server keeps what is not ASCII only in a national string.
  const national = tsql(style) && /[\u0080-￿]/.test(text) ? 'N' : '';
  return `${national}'${escaped}'`;
}

function value(each: ConditionValue, style: SqlStyle): string {
  if (each.kind === 'expression' && each.text.trim()) return each.text.trim();
  if (each.kind === 'number' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(each.text.trim()))
    return each.text.trim();
  return textLiteral(each.text, style);
}

function condition(item: Condition, style: SqlStyle): string {
  const column = item.column.trim();
  const operator = item.operator.toUpperCase();
  const values = item.values.map((each) => value(each, style));
  switch (operatorValues(item.operator)) {
    case 0:
      return `${column} ${operator}`;
    case 2:
      return `${column} ${operator} ${values[0] ?? "''"} AND ${values[1] ?? "''"}`;
  }
  if (item.operator === 'in' || item.operator === 'not in')
    return `${column} ${operator} (${values.length ? values.join(', ') : 'NULL'})`;
  return `${column} ${operator} ${values[0] ?? "''"}`;
}

/** A group's conditions; one inside another is in parentheses. */
export function groupSql(group: ConditionGroup, style: SqlStyle, nested = false): string {
  const parts = group.items
    .filter((item) => (isGroup(item) ? item.items.length : item.column.trim()))
    .map((item) => (isGroup(item) ? groupSql(item, style, true) : condition(item, style)));
  const joined = parts.join(group.match === 'any' ? ' OR ' : ' AND ');
  return nested && parts.length > 1 ? `(${joined})` : joined;
}

function column(each: QueryColumn, style: SqlStyle): string {
  const expression = each.expression.trim() || '*';
  const text =
    each.aggregate === 'count-distinct'
      ? `COUNT(DISTINCT ${expression})`
      : each.aggregate
        ? `${each.aggregate.toUpperCase()}(${expression})`
        : expression;
  return each.alias.trim() ? `${text} AS ${quoteName(each.alias.trim(), style)}` : text;
}

/** A table of the model as `FROM` names it. */
export function tableSql(table: QueryModel['tables'][number], style: SqlStyle): string {
  const name = table.path.map((part) => quoteName(part, style)).join('.');
  return table.alias ? `${name} ${quoteName(table.alias, style)}` : name;
}

/** The `SELECT` of a model; none when it has no table yet. */
export function querySql(model: QueryModel, style: SqlStyle): string {
  const [first] = model.tables;
  if (!first) return '';
  const top = tsql(style) && model.limit !== null && model.offset === null;
  const head = [
    'SELECT',
    ...(model.distinct ? ['DISTINCT'] : []),
    ...(top ? [`TOP (${model.limit})`] : []),
  ].join(' ');
  const columns = model.columns.length ? model.columns.map((each) => column(each, style)) : ['*'];
  const lines = [`${head} ${columns.join(',\n  ')}`, `FROM ${tableSql(first, style)}`];
  for (const join of model.joins) {
    const table = model.tables[join.table];
    if (!table) continue;
    const on = join.on.map((each) => `${each.left} ${each.operator} ${each.right}`);
    const kind = join.kind === 'inner' ? 'INNER' : `${join.kind.toUpperCase()} OUTER`;
    lines.push(
      `  ${kind} JOIN ${tableSql(table, style)}${on.length ? ` ON ${on.join(' AND ')}` : ' ON 1 = 1'}`,
    );
  }
  const where = model.where && groupSql(model.where, style);
  if (where) lines.push(`WHERE ${where}`);
  const groups = model.groupBy.map((each) => each.trim()).filter(Boolean);
  if (groups.length) lines.push(`GROUP BY ${groups.join(', ')}`);
  const having = model.having && groupSql(model.having, style);
  if (having) lines.push(`HAVING ${having}`);
  const order = model.orderBy
    .filter((each) => each.expression.trim())
    .map((each) => `${each.expression.trim()}${each.descending ? ' DESC' : ''}`);
  if (order.length) lines.push(`ORDER BY ${order.join(', ')}`);
  if (tsql(style) && model.offset !== null) {
    if (!order.length) lines.push('ORDER BY (SELECT NULL)');
    lines.push(
      `OFFSET ${model.offset} ROWS${model.limit !== null ? ` FETCH NEXT ${model.limit} ROWS ONLY` : ''}`,
    );
  } else if (!tsql(style)) {
    // MySQL and SQLite skip rows only after a limit: theirs for «all the rest».
    const rest = (REST as Record<string, string | undefined>)[style.name];
    if (model.limit !== null) lines.push(`LIMIT ${model.limit}`);
    else if (model.offset !== null && rest) lines.push(`LIMIT ${rest}`);
    if (model.offset !== null) lines.push(`OFFSET ${model.offset}`);
  }
  return lines.join('\n');
}
