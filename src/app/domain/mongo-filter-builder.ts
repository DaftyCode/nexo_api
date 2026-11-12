/**
 * A query filter as blocks: conditions (field, operator, value) in groups where all or any
 * must hold. A filter becomes blocks when they can show it exactly, and blocks become the
 * filter again in the shell syntax; the value of each condition is written in that syntax.
 */
import { bsonType, isPlain, shellText } from './bson';
import { QuerySyntaxError } from './mongo-query/reader';
import { shellToExtendedJson } from './mongo-query';

export const BLOCK_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
  '$regex',
] as const;
export type BlockOperator = (typeof BLOCK_OPERATORS)[number];

export interface Condition {
  kind: 'condition';
  field: string;
  operator: BlockOperator;
  /** The value in the shell syntax: `"A"`, `5`, `ISODate("…")`, `[1, 2]`, `true`. */
  value: string;
}
export interface Group {
  kind: 'group';
  /** `$and`: all must hold; `$or`: any. */
  join: '$and' | '$or';
  items: Block[];
}
export type Block = Condition | Group;

export const emptyGroup = (): Group => ({ kind: 'group', join: '$and', items: [] });
export const emptyCondition = (field = ''): Condition => ({
  kind: 'condition',
  field,
  operator: '$eq',
  value: '',
});

type Plain = Record<string, unknown>;

/** The conditions of one field: `{age: 5}` or `{age: {$gt: 1, $lt: 9}}`. */
function fieldConditions(field: string, value: unknown): Condition[] | undefined {
  // A BSON value such as `{$oid: …}` or a regular expression is compared, not opened.
  const operators = isPlain(value) && bsonType(value) === 'Document' ? Object.keys(value) : [];
  if (operators.length && operators.every((key) => key.startsWith('$'))) {
    if (!operators.every((key) => (BLOCK_OPERATORS as readonly string[]).includes(key)))
      return undefined;
    return operators.map((operator) => ({
      kind: 'condition',
      field,
      operator: operator as BlockOperator,
      value: shellText((value as Plain)[operator]),
    }));
  }
  return [{ kind: 'condition', field, operator: '$eq', value: shellText(value) }];
}

function documentGroup(document: Plain, join: Group['join'] = '$and'): Group | undefined {
  const keys = Object.keys(document);
  if (keys.length === 1 && (keys[0] === '$and' || keys[0] === '$or')) {
    const items = document[keys[0]];
    if (!Array.isArray(items)) return undefined;
    const blocks: Block[] = [];
    for (const item of items) {
      if (!isPlain(item)) return undefined;
      const group = documentGroup(item);
      if (!group) return undefined;
      // A document of one condition is that condition.
      blocks.push(group.items.length === 1 && group.join === '$and' ? group.items[0] : group);
    }
    return { kind: 'group', join: keys[0], items: blocks };
  }
  const items: Block[] = [];
  for (const key of keys) {
    if (key === '$and' || key === '$or') {
      const nested = documentGroup({ [key]: document[key] });
      if (!nested) return undefined;
      items.push(nested);
      continue;
    }
    if (key.startsWith('$')) return undefined;
    const conditions = fieldConditions(key, document[key]);
    if (!conditions) return undefined;
    items.push(...conditions);
  }
  return { kind: 'group', join, items };
}

/** The blocks of a filter typed in the shell syntax, or `undefined` when they cannot show it. */
export function filterBlocks(text: string): Group | undefined {
  if (!text.trim()) return emptyGroup();
  let value: unknown;
  try {
    value = shellToExtendedJson(text);
  } catch (error) {
    if (error instanceof QuerySyntaxError) return undefined;
    throw error;
  }
  return isPlain(value) ? documentGroup(value) : undefined;
}

/** A condition whose value cannot be read, and why. */
export class BlockError extends Error {
  constructor(
    readonly condition: Condition,
    readonly key: string,
  ) {
    super(key);
  }
}

function conditionValue(condition: Condition): unknown {
  try {
    const value = shellToExtendedJson(condition.value || 'null');
    if ((condition.operator === '$in' || condition.operator === '$nin') && !Array.isArray(value))
      throw new BlockError(condition, 'mongo.blocks.list');
    return value;
  } catch (error) {
    if (error instanceof QuerySyntaxError) throw new BlockError(condition, 'mongo.blocks.value');
    throw error;
  }
}

/** A document of query operators: `{$gt: 1, $lt: 9}`. */
const operators = (value: unknown): value is Plain =>
  isPlain(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => key.startsWith('$'));
const disjoint = (a: Plain, b: Plain) => Object.keys(b).every((key) => !(key in a));

function blockDocument(block: Block): Plain | undefined {
  if (block.kind === 'condition') {
    if (!block.field.trim()) return undefined;
    const value = conditionValue(block);
    return { [block.field.trim()]: block.operator === '$eq' ? value : { [block.operator]: value } };
  }
  const documents = block.items
    .map(blockDocument)
    .filter((document): document is Plain => !!document);
  if (!documents.length) return undefined;
  if (documents.length === 1) return documents[0];
  if (block.join === '$and') {
    // Conditions on different fields merge into one document, as people write them.
    const merged: Plain = {};
    for (const document of documents)
      for (const [key, value] of Object.entries(document)) {
        const before = merged[key];
        if (!(key in merged)) merged[key] = value;
        else if (operators(before) && operators(value) && disjoint(before, value))
          merged[key] = { ...before, ...value };
        else return { $and: documents };
      }
    return merged;
  }
  return { $or: documents };
}

/** The filter of the blocks, in the shell syntax; `''` when they say nothing. */
export function blocksFilter(group: Group): string {
  const document = blockDocument(group);
  return document ? shellText(document) : '';
}
