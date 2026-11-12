import type { AggregationOptions, PipelineStage } from '../mongo-aggregation';

/** A saved aggregation: where it runs, its stages as typed (also those turned off) and options. */
export interface MongoAggregationValue {
  /** The id of its connection document. */
  connection: string;
  database: string;
  collection: string;
  stages: PipelineStage[];
  options: AggregationOptions;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const record = (value: unknown) =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<
    string,
    unknown
  >;

/** The stages of a stored value, read defensively. */
export function storedStages(value: unknown): PipelineStage[] {
  return (Array.isArray(value) ? value : []).map((item) => {
    const stage = record(item);
    return {
      operator: text(stage['operator']),
      body: text(stage['body']),
      enabled: stage['enabled'] !== false,
    };
  });
}

/** Reads a stored aggregation defensively. */
export function aggregationValue(value: unknown): MongoAggregationValue {
  const stored = record(value);
  const options = record(stored['options']);
  return {
    connection: text(stored['connection']),
    database: text(stored['database']),
    collection: text(stored['collection']),
    stages: storedStages(stored['stages']),
    options: {
      collation: text(options['collation']),
      hint: text(options['hint']),
      allowDiskUse: options['allowDiskUse'] === true,
      maxTimeMS: text(options['maxTimeMS']),
    },
  };
}
