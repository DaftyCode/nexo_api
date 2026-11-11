import { compact, examinedRatio, explainPlan } from './mongo-explain';
// Real answers of `mongo.explain`, written by MongoDB 4.4, 6.0, 7.0 and 8.0 for the same
// 2,000 orders: `{status: 'A'}` sorted by `{at: -1}` with a limit of 10, without an index and
// with `{status: 1, at: -1}`, and an aggregation that groups by city.
import collscan44 from '../testing/explain/mongo-4.4-collscan.json';
import collscan60 from '../testing/explain/mongo-6.0-collscan.json';
import collscan70 from '../testing/explain/mongo-7.0-collscan.json';
import collscan80 from '../testing/explain/mongo-8.0-collscan.json';
import ixscan44 from '../testing/explain/mongo-4.4-ixscan.json';
import ixscan60 from '../testing/explain/mongo-6.0-ixscan.json';
import ixscan70 from '../testing/explain/mongo-7.0-ixscan.json';
import ixscan80 from '../testing/explain/mongo-8.0-ixscan.json';
import aggregate44 from '../testing/explain/mongo-4.4-aggregate.json';
import aggregate60 from '../testing/explain/mongo-6.0-aggregate.json';
import aggregate70 from '../testing/explain/mongo-7.0-aggregate.json';
import aggregate80 from '../testing/explain/mongo-8.0-aggregate.json';
import planner80 from '../testing/explain/mongo-8.0-planner.json';

const names = (explain: unknown) => explainPlan(explain).stages.map((stage) => stage.name);

describe('explain plans', () => {
  it.each([
    ['4.4', collscan44],
    ['6.0', collscan60],
    ['7.0', collscan70],
    ['8.0', collscan80],
  ])(
    'MongoDB %s: a query without an index scans the collection and sorts in memory',
    (_, explain) => {
      const plan = explainPlan(explain);
      expect(plan.stages.map((s) => [s.name, s.warning])).toEqual([
        ['COLLSCAN', 'collscan'],
        ['SORT', 'memorySort'],
      ]);
      expect(plan).toMatchObject({
        executed: true,
        returned: 10,
        docsExamined: 2000,
        keysExamined: 0,
        collscan: true,
        memorySort: true,
        indexes: [],
        engine: 'classic',
      });
      expect(plan.stages[0]).toMatchObject({ returned: 500, docsExamined: 2000 });
      expect(plan.stages[0].details).toContainEqual({
        label: 'Filter',
        value: '{ status: { $eq: "A" } }',
      });
      expect(plan.stages[1].details).toContainEqual({ label: 'Sort', value: '{ at: -1 }' });
      expect(examinedRatio(plan)).toBe(200);
    },
  );

  it.each([
    ['4.4', ixscan44],
    ['6.0', ixscan60],
    ['7.0', ixscan70],
    ['8.0', ixscan80],
  ])(
    'MongoDB %s: with the index, the plan reads the index and fetches only what it returns',
    (_, explain) => {
      const plan = explainPlan(explain);
      expect(plan.stages.map((s) => s.name)).toEqual(['IXSCAN', 'FETCH', 'LIMIT']);
      expect(plan.stages[0]).toMatchObject({
        index: 'status_1_at_-1',
        keysExamined: 10,
        returned: 10,
        details: [{ label: 'Keys', value: '{ status: 1, at: -1 }' }],
      });
      expect(plan.stages[1]).toMatchObject({ docsExamined: 10 });
      expect(plan).toMatchObject({
        collscan: false,
        memorySort: false,
        indexes: ['status_1_at_-1'],
        returned: 10,
        docsExamined: 10,
        keysExamined: 10,
      });
      expect(examinedRatio(plan)).toBe(1);
    },
  );

  it.each([
    ['4.4', aggregate44],
    ['6.0', aggregate60],
    ['7.0', aggregate70],
  ])('MongoDB %s: an aggregation runs its query, then the stages of the pipeline', (_, explain) => {
    const plan = explainPlan(explain);
    // The query reads only the fields the group needs.
    expect(plan.stages.map((s) => s.name)).toEqual([
      'IXSCAN',
      'FETCH',
      'PROJECTION_DEFAULT',
      '$group',
      '$sort',
    ]);
    expect(plan.stages.at(-1)).toMatchObject({
      returned: 3,
      warning: 'memorySort',
      details: [{ label: 'Sort', value: '{ total: -1 }' }],
    });
    expect(plan.stages[3].returned).toBe(3);
    expect(plan).toMatchObject({
      executed: true,
      returned: 3,
      docsExamined: 1500,
      keysExamined: 1500,
      indexes: ['status_1_at_-1'],
      engine: 'classic',
    });
  });

  it('MongoDB 8.0: the slot-based engine runs the group, measured by plan node', () => {
    const plan = explainPlan(aggregate80);
    expect(plan.engine).toBe('sbe');
    expect(plan.stages.map((s) => s.name)).toEqual(['IXSCAN', 'FETCH', 'GROUP', '$sort']);
    expect(plan.stages.slice(0, 3)).toMatchObject([
      { index: 'status_1_at_-1', keysExamined: 1500, returned: 1500 },
      { docsExamined: 1500, returned: 1500 },
      { returned: 3 },
    ]);
    expect(plan).toMatchObject({ returned: 3, docsExamined: 1500, keysExamined: 1500 });
  });

  it('a plan only planned has its stages without measures', () => {
    const plan = explainPlan(planner80);
    expect(plan.executed).toBe(false);
    expect(plan.stages.map((s) => [s.name, s.returned])).toEqual([
      ['COLLSCAN', undefined],
      ['SORT', undefined],
    ]);
    expect(plan.collscan).toBe(true);
    expect(examinedRatio(plan)).toBeUndefined();
  });

  it('a sharded plan runs on each shard, then merges', () => {
    // The shape MongoDB documents for `mongos` (winningPlan.shards[], executionStages.shards[]).
    const plan = explainPlan({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { shardName: 'eu', winningPlan: { stage: 'COLLSCAN' } },
            {
              shardName: 'us',
              winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'a_1' } },
            },
          ],
        },
        rejectedPlans: [{ stage: 'COLLSCAN' }],
      },
      executionStats: {
        nReturned: 7,
        executionTimeMillis: { $numberLong: '12' },
        totalDocsExamined: 9,
        totalKeysExamined: 4,
        executionStages: {
          stage: 'SHARD_MERGE',
          nReturned: 7,
          shards: [
            {
              shardName: 'eu',
              executionStages: { stage: 'COLLSCAN', nReturned: 3, docsExamined: 5 },
            },
            {
              shardName: 'us',
              executionStages: {
                stage: 'FETCH',
                nReturned: 4,
                docsExamined: 4,
                inputStage: { stage: 'IXSCAN', indexName: 'a_1', keysExamined: 4, nReturned: 4 },
              },
            },
          ],
        },
      },
    });
    expect(plan.stages.map((s) => [s.shard, s.name, s.returned])).toEqual([
      ['eu', 'COLLSCAN', 3],
      ['us', 'IXSCAN', 4],
      ['us', 'FETCH', 4],
      [undefined, 'SHARD_MERGE', 7],
    ]);
    expect(plan).toMatchObject({ ms: 12, rejectedPlans: 1, collscan: true, indexes: ['a_1'] });
  });

  it('reads plans of OR queries, the _id shortcut and unknown shapes', () => {
    expect(
      names({
        queryPlanner: {
          winningPlan: {
            stage: 'SUBPLAN',
            inputStage: {
              stage: 'OR',
              inputStages: [
                { stage: 'IXSCAN', indexName: 'a_1' },
                { stage: 'IXSCAN', indexName: 'b_1' },
              ],
            },
          },
        },
      }),
    ).toEqual(['IXSCAN', 'IXSCAN', 'OR', 'SUBPLAN']);
    expect(explainPlan({ queryPlanner: { winningPlan: { stage: 'IDHACK' } } }).indexes).toEqual([
      '_id_',
    ]);
    expect(explainPlan(null)).toMatchObject({ stages: [], executed: false, collscan: false });
    expect(explainPlan({ stages: 'x' }).stages).toEqual([]);
  });

  it('writes small values as the shell does', () => {
    expect(compact({ a: 1, 'b.c': [true, null], $or: { x: 'y' } })).toBe(
      '{ a: 1, "b.c": [true, null], $or: { x: "y" } }',
    );
    expect(compact({})).toBe('{}');
  });
});
