import { describe, expect, it } from 'vitest';
import { addRow, columnName, deleteRows, editability, noEdits, setCell, undo } from './edits';
import { planRows, planWarnings, type ExplainPlan } from './plan';
import { cellText, rerunResult, summarize, type ResultColumn, type ResultTab } from './results';
import { bindParameters } from './sql-params';
import { evaluate, parseExpression, withVirtualColumns } from './virtual-columns';

const column = (name: string, extra: Partial<ResultColumn> = {}): ResultColumn => ({
  name,
  typeName: 'text',
  kind: 'text',
  ...extra,
});

describe('results, at their edges', () => {
  it('keeps the place and pin of a tab run again', () => {
    const tab = { id: 'a', order: 3, pinned: true, sql: 'x' } as unknown as ResultTab;
    const other = { id: 'b', order: 4, pinned: false, sql: 'y' } as unknown as ResultTab;
    const fresh = { id: 'new', order: 9, pinned: false, sql: 'x' } as unknown as ResultTab;
    expect(rerunResult([tab, other], 'a', fresh)).toEqual([
      { id: 'a', order: 3, pinned: true, sql: 'x' },
      other,
    ]);
  });

  it('writes typed arrays and values without a value, and summarizes typed numbers', () => {
    expect(cellText({ $t: 'array', v: [1, 'a'] })).toBe('[1, a]');
    expect(cellText({ $t: 'text' })).toBe('');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    const summary = summarize(
      [column('n'), column('e')],
      [
        [{ $t: 'integer', v: '10' }, null],
        [{ $t: 'integer', v: '9' }, null],
      ],
    );
    expect(summary[0]).toMatchObject({ min: '9', max: '10' });
    expect(summary[1]).toEqual({ name: 'e', distinct: 0, nulls: 2 });
  });
});

describe('edits, at their edges', () => {
  it('names a column by its origin, and edits a table without a schema', () => {
    expect(columnName(column('Shown', { origin: { column: 'real' } }))).toBe('real');
    const columns = [column('id', { key: true, origin: { table: 't' } })];
    expect(editability(columns, { readOnly: false })).toEqual({
      target: { table: 't', key: [0] },
    });
  });

  it('leaves a deleted row as it is, and edits only the new row asked', () => {
    let history = deleteRows(noEdits(), 2, [0]);
    expect(setCell(history, 2, 0, 0, 'x')).toBe(history);
    history = addRow(addRow(history, 1), 1);
    history = setCell(history, 2, 3, 0, 'second');
    expect(history.now.inserts[0][0]).not.toBe('second');
    expect(history.now.inserts[1][0]).toBe('second');
    expect(undo(noEdits())).toEqual(noEdits());
  });
});

describe('plans, at their edges', () => {
  const plan = (nodes: ExplainPlan['nodes']): ExplainPlan => ({
    mode: 'estimated',
    nodes,
    format: 'json',
    original: '',
  });

  it('gives no share without a measure, and warns of temporary tables and loops by operation', () => {
    expect(planRows(plan([{ operation: 'Scan' }]))[0].share).toBe(0);
    const warnings = planWarnings(plan([{ operation: 'Hash', flags: ['temporary'], loops: 2000 }]));
    expect(warnings.map((warning) => [warning.text, warning.params['v0']])).toEqual([
      ['db.plan.temporary', 'Hash'],
      ['db.plan.loops', 'Hash'],
    ]);
  });
});

describe('parameters, at their edges', () => {
  it('binds missing values as NULL in every style', () => {
    expect(bindParameters('SELECT :a, ?', 'question', {}, [])).toEqual({
      sql: 'SELECT ?, ?',
      params: [null, null],
    });
    expect(bindParameters('SELECT :a, :a', 'numbered', {})).toEqual({
      sql: 'SELECT $1, $1',
      params: [null],
    });
  });
});

describe('virtual columns, at their edges', () => {
  it('negates, ignores trailing spaces and leaves out what is not a number', () => {
    const value = (name: string) => ({ a: 4, b: 'x' })[name];
    expect(evaluate(parseExpression('-a  '), value)).toBe(-4);
    expect(evaluate(parseExpression('-b'), value)).toBeNull();
    expect(evaluate(parseExpression('a * b'), value)).toBeNull();
    const shown = withVirtualColumns(
      [column('a')],
      [[2]],
      [
        { name: 'double', expression: 'a * 2' },
        { name: 'ghost', expression: 'missing + 1' },
        { name: 'bad', expression: '((' },
      ],
    );
    expect(shown.columns.map((each) => each.name)).toEqual(['a', 'double', 'ghost']);
    expect(shown.rows).toEqual([[2, 4, null]]);
  });
});
