import { ExplainPlan, planRows, planSize, planWarnings } from './plan';

const estimated: ExplainPlan = {
  mode: 'estimated',
  format: 'json',
  original: '[]',
  nodes: [
    {
      operation: 'Sort',
      estimatedCost: 100,
      flags: ['disk-sort'],
      children: [
        {
          operation: 'Hash Join',
          estimatedCost: 80,
          children: [
            {
              operation: 'Seq Scan',
              object: 'orders',
              estimatedRows: 50_000,
              estimatedCost: 60,
              flags: ['full-scan'],
            },
            {
              operation: 'Seq Scan',
              object: 'tiny',
              estimatedRows: 3,
              estimatedCost: 1,
              flags: ['full-scan'],
            },
          ],
        },
      ],
    },
  ],
};

describe('execution plans', () => {
  it('lists the tree with bars by cost, and hides what a collapsed node holds', () => {
    const rows = planRows(estimated);
    expect(rows.map((row) => [row.id, row.depth, row.parent])).toEqual([
      ['0', 0, true],
      ['0.0', 1, true],
      ['0.0.0', 2, false],
      ['0.0.1', 2, false],
    ]);
    expect(rows.map((row) => row.share)).toEqual([1, 0.8, 0.6, 0.01]);
    expect(planRows(estimated, new Set(['0.0'])).map((row) => row.id)).toEqual(['0', '0.0']);
    expect(planSize(estimated)).toBe(4);
  });

  it('measures the bars by time once the plan was run', () => {
    const actual: ExplainPlan = {
      ...estimated,
      mode: 'actual',
      nodes: [
        {
          operation: 'Update',
          actualMs: 4,
          estimatedCost: 1,
          children: [{ operation: 'Index Scan', actualMs: 1, estimatedCost: 9 }],
        },
      ],
    };
    expect(planRows(actual).map((row) => row.share)).toEqual([1, 0.25]);
  });

  it('warns about big full scans, disk sorts, estimates far off and many loops', () => {
    expect(planWarnings(estimated).map((warning) => [warning.text, warning.id])).toEqual([
      ['db.plan.diskSort', '0'],
      ['db.plan.fullScan', '0.0.0'],
    ]);
    const measured: ExplainPlan = {
      ...estimated,
      nodes: [
        {
          operation: 'Nested Loop',
          children: [
            {
              operation: 'Index Scan',
              object: 'items',
              estimatedRows: 10,
              actualRows: 4000,
              loops: 5000,
            },
            // Read whole without any row figure (SQLite): still worth a warning.
            { operation: 'SCAN', object: 'o', flags: ['full-scan'] },
            {
              operation: 'Seq Scan',
              object: 'n',
              actualRows: 10,
              estimatedRows: 12,
              flags: ['full-scan'],
              details: { 'Rows Removed by Filter': '99990' },
            },
          ],
        },
      ],
    };
    expect(planWarnings(measured)).toEqual([
      { text: 'db.plan.misestimate', params: { v0: 'items', v1: '10', v2: '4000' }, id: '0.0' },
      { text: 'db.plan.loops', params: { v0: 'items', v1: '5000' }, id: '0.0' },
      { text: 'db.plan.fullScan', params: { v0: 'o' }, id: '0.1' },
      { text: 'db.plan.fullScan', params: { v0: 'n' }, id: '0.2' },
    ]);
  });
});
