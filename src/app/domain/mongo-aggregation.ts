/**
 * Aggregation pipelines built stage by stage. Each stage is typed in the shell's syntax or in
 * Extended JSON, like the fields of a query, and can be turned off. `$out` and `$merge`
 * write: the preview of a stage never carries them, and they can only be the last stage.
 */

import { bsonType, shell } from './bson';
import { type Json, QuerySyntaxError } from './mongo-query/reader';
import { shellToExtendedJson } from './mongo-query';
import { STAGE_TEMPLATES } from './mongo-aggregation/templates';

export { STAGE_OPERATORS, STAGE_TEMPLATES } from './mongo-aggregation/templates';
export { aggregationValue, storedStages } from './mongo-aggregation/value';
export type { MongoAggregationValue } from './mongo-aggregation/value';

/** A stage as typed: its operator, its value and whether it runs. */
export interface PipelineStage {
  operator: string;
  body: string;
  enabled: boolean;
}

/** The options of the whole pipeline, as typed. */
export interface AggregationOptions {
  collation: string;
  /** An index name, or its keys as a document. */
  hint: string;
  allowDiskUse: boolean;
  /** Milliseconds; empty for the limit of Nexo. */
  maxTimeMS: string;
}

/** The options ready to send. */
export interface BuiltAggregationOptions {
  collation?: Record<string, unknown>;
  hint?: string | Record<string, unknown>;
  allowDiskUse?: boolean;
  maxTimeMS?: number;
}

export type PipelineDocument = Record<string, unknown>;

/** Stages that write their results to a collection. */
export const WRITING_STAGES: readonly string[] = ['$out', '$merge'];

const VARIABLE = /\{\{\s*([^{}]+?)\s*\}\}/;
const OPERATOR = /^\$[A-Za-z]+$/;

export function emptyAggregationOptions(): AggregationOptions {
  return { collation: '', hint: '', allowDiskUse: false, maxTimeMS: '' };
}

/** A new stage with the value its operator starts with. */
export function newStage(operator: string): PipelineStage {
  return { operator, body: STAGE_TEMPLATES[operator] ?? '{}', enabled: true };
}

export function writes(stage: Pick<PipelineStage, 'operator'>): boolean {
  return WRITING_STAGES.includes(stage.operator.trim());
}

/** A stage, or an option, that cannot be used: which one, the message key and its values. */
export class StageError extends Error {
  constructor(
    /** The stage's position in the list, or `-1` for the options. */
    readonly stage: number,
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(`${stage}: ${key}`);
  }
}

/** A value typed in the shell's syntax, with the variables of the environment replaced. */
function parse(source: string, stage: number, resolve: (text: string) => string): Json {
  const text = resolve(source);
  const variable = VARIABLE.exec(text);
  if (variable) throw new StageError(stage, 'mongo.undefinedVariable', { v0: variable[1] });
  try {
    return shellToExtendedJson(text);
  } catch (error) {
    if (!(error instanceof QuerySyntaxError)) throw error;
    throw new StageError(stage, 'mongo.syntax', {
      v0: error.reason,
      v1: error.line,
      v2: error.column,
      v3: error.detail,
    });
  }
}

/** The document a stage sends: `{operator: value}`. */
export function stageDocument(
  stage: PipelineStage,
  index: number,
  resolve: (text: string) => string = (t) => t,
): PipelineDocument {
  const operator = stage.operator.trim();
  if (!OPERATOR.test(operator))
    throw new StageError(index, 'mongo.stage.operator', { v0: operator });
  if (!stage.body.trim()) throw new StageError(index, 'Write the value of the stage');
  return { [operator]: parse(stage.body, index, resolve) };
}

/** The stages that run, in order, with their position in the list. */
function enabled(stages: readonly PipelineStage[]) {
  return stages.map((stage, index) => ({ stage, index })).filter(({ stage }) => stage.enabled);
}

/** The pipeline that runs: the stages turned on. `$out` or `$merge` only last. */
export function buildPipeline(
  stages: readonly PipelineStage[],
  resolve?: (text: string) => string,
): PipelineDocument[] {
  const running = enabled(stages);
  if (!running.length) throw new StageError(-1, 'Add at least one stage');
  return running.map(({ stage, index }, position) => {
    if (writes(stage) && position < running.length - 1)
      throw new StageError(index, 'mongo.stage.last', { v0: stage.operator.trim() });
    return stageDocument(stage, index, resolve);
  });
}

/**
 * The preview of a stage: the stages turned on up to it, never one that writes, and a
 * `$limit` at the end so it is quick.
 */
export function previewPipeline(
  stages: readonly PipelineStage[],
  upTo: number,
  limit: number,
  resolve?: (text: string) => string,
): PipelineDocument[] {
  return [
    ...enabled(stages.slice(0, upTo + 1))
      .filter(({ stage }) => !writes(stage))
      .map(({ stage, index }) => stageDocument(stage, index, resolve)),
    { $limit: limit },
  ];
}

/** The pipeline without its writing stage: what an explain or an export reads. */
export function readingPipeline(pipeline: readonly PipelineDocument[]): PipelineDocument[] {
  return pipeline.filter((stage) => !WRITING_STAGES.some((name) => name in stage));
}

/** The collection a writing stage writes to, to repeat its name; `''` when it names none. */
export function writtenCollection(stage: PipelineDocument): string {
  const value = stage['$out'] ?? stage['$merge'];
  const target =
    '$merge' in stage && value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)['into']
      : value;
  if (typeof target === 'string') return target.trim();
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const name = (target as Record<string, unknown>)['coll'];
    return typeof name === 'string' ? name.trim() : '';
  }
  return '';
}

/** The options to send; an unusable one is a `StageError` of stage `-1`. */
export function buildAggregationOptions(
  options: AggregationOptions,
  resolve: (text: string) => string = (t) => t,
): BuiltAggregationOptions {
  const built: BuiltAggregationOptions = {};
  if (options.collation.trim()) {
    const collation = parse(options.collation, -1, resolve);
    if (!collation || typeof collation !== 'object' || Array.isArray(collation))
      throw new StageError(-1, 'mongo.notDocument');
    built.collation = collation as Record<string, unknown>;
  }
  const hint = resolve(options.hint).trim();
  if (hint.startsWith('{')) built.hint = parse(hint, -1, (t) => t) as Record<string, unknown>;
  else if (hint) built.hint = hint.replace(/^(['"])(.*)\1$/, '$2');
  if (options.allowDiskUse) built.allowDiskUse = true;
  const time = options.maxTimeMS.trim();
  if (time) {
    if (!/^\d+$/.test(time) || !Number.isSafeInteger(Number(time)))
      throw new StageError(-1, 'mongo.notCount');
    if (Number(time)) built.maxTimeMS = Number(time);
  }
  return built;
}

/** The stages turned on as one array in the shell's syntax, as typed. */
export function pipelineText(stages: readonly PipelineStage[]): string {
  const items = enabled(stages).map(
    ({ stage }) =>
      `  {\n    ${stage.operator.trim()}: ${stage.body.trim().replace(/\n/g, '\n    ')}\n  }`,
  );
  return items.length ? `[\n${items.join(',\n')}\n]` : '[]';
}

/** A value of a pasted stage in the shell's syntax; plain numbers stay plain, as typed. */
function stageText(value: unknown, indent = 0): string {
  if (typeof value === 'number') return String(value);
  const type = bsonType(value);
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (type === 'Array') {
    const items = value as unknown[];
    if (!items.length) return '[]';
    const lines = items.map((item) => pad + stageText(item, indent + 1));
    return `[\n${lines.join(',\n')}\n${end}]`;
  }
  if (type === 'Document') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
    const lines = entries.map(
      ([name, item]) => `${pad}${key(name)}: ${stageText(item, indent + 1)}`,
    );
    return `{\n${lines.join(',\n')}\n${end}}`;
  }
  return shell(value);
}

/** The stages of a pipeline typed or pasted as an array, in the shell's syntax or JSON. */
export function stagesFromText(text: string): PipelineStage[] {
  const value = parse(text, -1, (t) => t);
  if (!Array.isArray(value)) throw new StageError(-1, 'mongo.stage.array');
  return value.map((item, index) => {
    const entries =
      item && typeof item === 'object' && !Array.isArray(item) ? Object.entries(item) : [];
    if (entries.length !== 1 || !OPERATOR.test(entries[0][0]))
      throw new StageError(-1, 'mongo.stage.one', { v0: index + 1 });
    const [operator, body] = entries[0];
    return { operator, body: stageText(body), enabled: true };
  });
}
