import { describe, expect, it } from 'vitest';
import { shellText } from './bson';
import { examinedRatio, explainPlan } from './mongo-explain';

describe('MongoDB explains, at their edges', () => {
  it('reads a backward scan that used the disk, and a stage without a name', () => {
    const plan = explainPlan({
      queryPlanner: {
        winningPlan: {
          stage: 'SORT',
          usedDisk: true,
          inputStage: { direction: 'backward', keyPattern: { at: 1 } },
        },
      },
    });
    expect(plan.stages.map((stage) => stage.name)).toEqual(['?', 'SORT']);
    expect(plan.stages[0].details).toContainEqual({ label: 'Direction', value: '"backward"' });
    expect(plan.stages[1].details).toContainEqual({ label: 'Used disk', value: '✓' });
    expect(plan.memorySort).toBe(true);
    expect(plan.executed).toBe(false);
  });

  it('adds up what the slot-based engine examined in each node', () => {
    const plan = explainPlan({
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'FETCH',
            planNodeId: 2,
            inputStage: { stage: 'IXSCAN', planNodeId: 1 },
          },
        },
      },
      executionStats: {
        nReturned: 2,
        totalDocsExamined: 2,
        totalKeysExamined: 3,
        executionStages: {
          stage: 'nlj',
          planNodeId: 2,
          nReturned: 2,
          outerStage: { stage: 'ixseek', planNodeId: 1, keysExamined: 3, nReturned: 2 },
          innerStage: {
            stage: 'seek',
            planNodeId: 2,
            numReads: 2,
            innerStage: { stage: 'limit', planNodeId: 2, keysExamined: 1 },
          },
          thenStage: { stage: 'other' },
        },
      },
    });
    expect(plan.engine).toBe('sbe');
    const fetch = plan.stages.find((stage) => stage.name === 'FETCH');
    expect(fetch).toMatchObject({ returned: 2, docsExamined: 2, keysExamined: 1 });
    expect(examinedRatio(plan)).toBe(1.5);
  });

  it('reads a pipeline without a query cursor, with a sort that used the disk', () => {
    const plan = explainPlan({
      stages: [
        {
          $sort: { sortKey: { a: 1 } },
          usedDisk: true,
          nReturned: 4,
          executionTimeMillisEstimate: 9,
        },
        {},
      ],
    });
    expect(plan.stages.map((stage) => stage.name)).toEqual(['$sort', '?']);
    expect(plan.stages[0].details).toEqual([
      { label: 'Used disk', value: '✓' },
      { label: 'Sort', value: '{ a: 1 }' },
    ]);
    expect(plan.executed).toBe(true);
    expect(plan.ms).toBe(0);
  });

  it('gives a ratio only for an executed plan, infinite when nothing came back', () => {
    const executed = {
      ...explainPlan({}),
      executed: true,
      docsExamined: 10,
      returned: 0,
    };
    expect(examinedRatio(executed)).toBe(Infinity);
    expect(examinedRatio({ ...executed, docsExamined: 0 })).toBe(0);
    expect(examinedRatio({ ...executed, executed: false })).toBeUndefined();
  });
});

describe('BSON written as the shell writes it, at its edges', () => {
  it('writes the rarer types and empty values', () => {
    expect(
      shellText({
        whole: { $numberDouble: '2' },
        int: { $numberInt: '3' },
        far: { $date: { $numberLong: '99999999999999999' } },
        code: { $code: 'x' },
        symbol: { $symbol: 's' },
        pointer: { $dbPointer: { $ref: 'c', $id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' } } },
        none: { $undefined: true },
        list: [],
        empty: {},
        'odd-key': 1,
      }),
    ).toBe(`{
  whole: 2.0,
  int: NumberInt(3),
  far: new Date(99999999999999999),
  code: Code("x"),
  symbol: Symbol("s"),
  pointer: DBPointer("c", ObjectId("65a1b2c3d4e5f6a7b8c9d0e1")),
  none: undefined,
  list: [],
  empty: {},
  "odd-key": 1
}`);
  });
});
