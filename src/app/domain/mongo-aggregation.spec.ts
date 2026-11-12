import {
  PipelineStage,
  STAGE_OPERATORS,
  STAGE_TEMPLATES,
  StageError,
  aggregationValue,
  buildAggregationOptions,
  buildPipeline,
  emptyAggregationOptions,
  newStage,
  pipelineText,
  previewPipeline,
  readingPipeline,
  stagesFromText,
  writtenCollection,
} from './mongo-aggregation';

const stage = (operator: string, body: string, enabled = true): PipelineStage => ({
  operator,
  body,
  enabled,
});

const failure = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof StageError) return [error.stage, error.key, error.params];
    throw error;
  }
  throw new Error('It did not fail');
};

describe('MongoDB aggregation pipelines', () => {
  const stages = [
    stage('$match', "{status: '{{status}}'}"),
    stage('$lookup', "{from: 'customers', localField: 'customer', foreignField: '_id', as: 'c'}"),
    stage('$unwind', "'$c'", false),
    stage('$group', "{_id: '$c.city', n: {$sum: 1}}"),
    stage('$out', "'summary'"),
  ];
  const resolve = (text: string) => text.replace('{{status}}', 'A');

  it('runs the stages turned on, with the variables of the environment', () => {
    expect(buildPipeline(stages, resolve)).toEqual([
      { $match: { status: 'A' } },
      { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'c' } },
      { $group: { _id: '$c.city', n: { $sum: 1 } } },
      { $out: 'summary' },
    ]);
    expect(failure(() => buildPipeline(stages))).toEqual([
      0,
      'mongo.undefinedVariable',
      { v0: 'status' },
    ]);
  });

  it('previews a stage without the stages that write, and with a limit at the end', () => {
    expect(previewPipeline(stages, 1, 20, resolve)).toEqual([
      { $match: { status: 'A' } },
      { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'c' } },
      { $limit: 20 },
    ]);
    // A stage turned off is left out; `$out` and `$merge` never run in a preview.
    const preview = previewPipeline(
      [...stages.slice(0, 4), stage('$merge', "{into: 'copy'}")],
      4,
      10,
      resolve,
    );
    expect(preview.map((s) => Object.keys(s)[0])).toEqual([
      '$match',
      '$lookup',
      '$group',
      '$limit',
    ]);
    expect(previewPipeline(stages, 4, 5, resolve).at(-1)).toEqual({ $limit: 5 });
    expect(readingPipeline(buildPipeline(stages, resolve))).toHaveLength(3);
  });

  it('says which stage cannot be used, and why', () => {
    expect(failure(() => buildPipeline([stage('match', '{}')]))).toEqual([
      0,
      'mongo.stage.operator',
      { v0: 'match' },
    ]);
    expect(failure(() => buildPipeline([stage('$match', '{}'), stage('$limit', ' ')]))).toEqual([
      1,
      'Write the value of the stage',
      {},
    ]);
    expect(failure(() => buildPipeline([stage('$match', '{a: }')]))[1]).toBe('mongo.syntax');
    expect(failure(() => buildPipeline([stage('$out', "'a'"), stage('$limit', '1')]))).toEqual([
      0,
      'mongo.stage.last',
      { v0: '$out' },
    ]);
    expect(failure(() => buildPipeline([stage('$match', '{}', false)]))[1]).toBe(
      'Add at least one stage',
    );
    // A writing stage turned off does not count.
    expect(buildPipeline([stage('$out', "'a'", false), stage('$limit', '1')])).toEqual([
      { $limit: 1 },
    ]);
  });

  it('names the collection a writing stage writes to', () => {
    expect(writtenCollection({ $out: 'copy' })).toBe('copy');
    expect(writtenCollection({ $out: { db: 'other', coll: 'copy' } })).toBe('copy');
    expect(writtenCollection({ $merge: 'copy' })).toBe('copy');
    expect(writtenCollection({ $merge: { into: 'copy', on: '_id' } })).toBe('copy');
    expect(writtenCollection({ $merge: { into: { db: 'o', coll: 'copy' } } })).toBe('copy');
    expect(writtenCollection({ $merge: { on: '_id' } })).toBe('');
  });

  it('reads the options of the pipeline', () => {
    expect(buildAggregationOptions(emptyAggregationOptions())).toEqual({});
    expect(
      buildAggregationOptions({
        collation: "{locale: 'es'}",
        hint: "'status_1'",
        allowDiskUse: true,
        maxTimeMS: '5000',
      }),
    ).toEqual({
      collation: { locale: 'es' },
      hint: 'status_1',
      allowDiskUse: true,
      maxTimeMS: 5000,
    });
    expect(buildAggregationOptions({ ...emptyAggregationOptions(), hint: '{a: 1}' }).hint).toEqual({
      a: 1,
    });
    expect(
      failure(() => buildAggregationOptions({ ...emptyAggregationOptions(), maxTimeMS: '1.5' })),
    ).toEqual([-1, 'mongo.notCount', {}]);
    expect(
      failure(() => buildAggregationOptions({ ...emptyAggregationOptions(), collation: '[1]' })),
    ).toEqual([-1, 'mongo.notDocument', {}]);
  });

  it('turns the pipeline into text and back', () => {
    const text = pipelineText(stages);
    expect(text).toContain("$match: {status: '{{status}}'}");
    expect(text).not.toContain('$unwind');
    const read = stagesFromText(resolve(text));
    expect(read.map((s) => s.operator)).toEqual(['$match', '$lookup', '$group', '$out']);
    expect(buildPipeline(read)).toEqual(buildPipeline(stages, resolve));
    expect(stagesFromText('[{"$limit": 5}]')).toEqual([
      { operator: '$limit', body: '5', enabled: true },
    ]);
    expect(pipelineText([])).toBe('[]');
    expect(failure(() => stagesFromText('{}'))).toEqual([-1, 'mongo.stage.array', {}]);
    expect(failure(() => stagesFromText('[{$match: {}, $limit: 1}]'))).toEqual([
      -1,
      'mongo.stage.one',
      { v0: 1 },
    ]);
  });

  it('starts every stage from a template the shell syntax reads', () => {
    for (const operator of STAGE_OPERATORS) {
      expect(() => buildPipeline([newStage(operator)])).not.toThrow();
      expect(newStage(operator).body).toBe(STAGE_TEMPLATES[operator]);
    }
    expect(newStage('$densify')).toEqual({ operator: '$densify', body: '{}', enabled: true });
  });

  it('reads a saved aggregation defensively', () => {
    expect(aggregationValue(null)).toEqual({
      connection: '',
      database: '',
      collection: '',
      stages: [],
      options: emptyAggregationOptions(),
    });
    const value = aggregationValue({
      connection: 'c1',
      database: 'shop',
      collection: 'orders',
      stages: [{ operator: '$match', body: '{}', enabled: false }, { operator: 1 }, 'x'],
      options: { hint: 'a_1', allowDiskUse: true, maxTimeMS: 7 },
    });
    expect(value.stages).toEqual([
      { operator: '$match', body: '{}', enabled: false },
      { operator: '', body: '', enabled: true },
      { operator: '', body: '', enabled: true },
    ]);
    expect(value.options).toEqual({
      collation: '',
      hint: 'a_1',
      allowDiskUse: true,
      maxTimeMS: '',
    });
  });
});
