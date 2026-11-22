import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { QueryModel, emptyQuery } from '../../domain/db/query-model';
import { builderLayout } from '../../domain/db/query-model/layout';
import { buttons } from '../../testing/controls';
import { testProviders } from '../../testing/providers';
import { DbQueryCanvas } from './canvas';
import { DbQueryPanels } from './panels';

const model: QueryModel = {
  ...emptyQuery(),
  tables: [
    { path: ['public', 'orders'], alias: 'o' },
    { path: ['public', 'users'], alias: 'u' },
  ],
  joins: [{ table: 1, kind: 'inner', on: [{ left: 'u.id', operator: '=', right: 'o.user_id' }] }],
  columns: [
    { expression: 'o.id', alias: '', aggregate: '' },
    { expression: '*', alias: 'n', aggregate: 'count' },
  ],
};

async function panels(start: QueryModel = model) {
  await TestBed.configureTestingModule({
    providers: testProviders(),
    imports: [DbQueryPanels],
  }).compileComponents();
  const fixture: ComponentFixture<DbQueryPanels> = TestBed.createComponent(DbQueryPanels);
  fixture.componentRef.setInput('model', start);
  const changes: QueryModel[] = [];
  fixture.componentInstance.changed.subscribe((next) => {
    changes.push(next);
    fixture.componentRef.setInput('model', next);
  });
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const click = async (text: string | RegExp, at = 0) => {
    buttons(root, text)[at].click();
    await fixture.whenStable();
  };
  const set = async (selector: string, value: string, at = 0) => {
    const element = root.querySelectorAll<HTMLInputElement>(selector)[at];
    element.value = value;
    element.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  return { fixture, root, changes, click, set, last: () => changes.at(-1)! };
}

describe('the panels of the visual query builder', () => {
  it('edits, moves and removes columns, and groups by those without an aggregate', async () => {
    const p = await panels();
    await p.set('input[aria-label="Alias"]', 'key');
    expect(p.last().columns[0].alias).toBe('key');
    await p.set('select[aria-label="Aggregate"]', 'max', 0);
    expect(p.last().columns[0].aggregate).toBe('max');
    await p.set('select[aria-label="Aggregate"]', '', 0);
    await p.click('Move down');
    expect(p.last().columns.map((c) => c.expression)).toEqual(['*', 'o.id']);
    await p.click('Move up', 0);
    expect(p.last().columns.map((c) => c.expression)).toEqual(['*', 'o.id']);
    await p.click('＋ Column');
    await p.set('input[aria-label="Column or expression"]', 'o.total', 2);
    await p.click('Remove the column', 2);
    expect(p.last().columns).toHaveLength(2);
    await p.click(/^Grouping$/);
    await p.click('Group by the columns without an aggregate');
    expect(p.last().groupBy).toEqual(['o.id']);
    await p.click('＋ Group by');
    await p.set('input[aria-label="Column or expression"]', 'o.kind', 1);
    expect(p.last().groupBy).toEqual(['o.id', 'o.kind']);
    await p.click('Remove', 1);
    expect(p.last().groupBy).toEqual(['o.id']);
  });

  it('edits the order, the joins and the page', async () => {
    const p = await panels();
    await p.click(/^Order$/);
    await p.click('＋ Order by');
    await p.set('input[aria-label="Column or expression"]', 'o.id');
    const box = p.root.querySelector<HTMLInputElement>('.qb-panel input[type="checkbox"]')!;
    box.click();
    await p.fixture.whenStable();
    expect(p.last().orderBy).toEqual([{ expression: 'o.id', descending: true }]);
    await p.click('Remove');
    expect(p.last().orderBy).toEqual([]);
    await p.click(/^Joins$/);
    await p.set('select[aria-label="Kind of join"]', 'full');
    await p.set('select[aria-label="Operator"]', '<>');
    await p.set('input[aria-label="Column or expression"]', 'u.key', 0);
    await p.set('input[aria-label="Column or expression"]', 'o.key', 1);
    expect(p.last().joins[0]).toEqual({
      table: 1,
      kind: 'full',
      on: [{ left: 'u.key', operator: '<>', right: 'o.key' }],
    });
    await p.click('＋ Comparison');
    expect(p.last().joins[0].on).toHaveLength(2);
    await p.click('Remove', 1);
    expect(p.last().joins[0].on).toHaveLength(1);
    expect(p.root.textContent).toContain('u');
    await p.click(/^Page$/);
    await p.set('.qb-panel input[inputmode="numeric"]', '20', 1);
    await p.set('.qb-panel input[inputmode="numeric"]', 'x', 0);
    expect([p.last().limit, p.last().offset]).toEqual([null, 20]);
    p.root.querySelector<HTMLInputElement>('.qb-panel input[type="checkbox"]')!.click();
    await p.fixture.whenStable();
    expect(p.last().distinct).toBe(true);
  });

  it('builds groups of conditions, with as many values as each operator takes', async () => {
    const p = await panels({ ...model, joins: [] });
    await p.click(/^Joins$/);
    expect(p.root.textContent).toContain('Add a second table to join it.');
    await p.click(/^Conditions$/);
    await p.click('＋ Condition');
    await p.set('select[aria-label="Operator"]', 'between');
    expect(p.last().where!.items[0]).toMatchObject({ operator: 'between', values: [{}, {}] });
    await p.set('select[aria-label="Operator"]', 'in');
    await p.click('＋ Value');
    expect(p.last().where!.items[0]).toMatchObject({ operator: 'in', values: [{}, {}, {}] });
    await p.set('select[aria-label="Operator"]', 'is null');
    expect(p.last().where!.items[0]).toMatchObject({ values: [] });
    await p.set('select[aria-label="Operator"]', '=');
    await p.set('select[aria-label="Kind of value"]', 'number');
    await p.set('input[aria-label="Value"]', '3');
    expect(p.last().where!.items[0]).toEqual({
      column: '',
      operator: '=',
      values: [{ text: '3', kind: 'number' }],
    });
    await p.click('＋ Group');
    expect(p.last().where!.items[1]).toMatchObject({ match: 'any' });
    await p.set('select[aria-label="Match"]', 'any');
    expect(p.last().where!.match).toBe('any');
    // A condition inside the nested group.
    await p.set('.qb-nested input[aria-label="Column or expression"]', 'o.id');
    expect(p.last().where!.items[1]).toMatchObject({ items: [{ column: 'o.id' }] });
    await p.click('Remove the group');
    await p.click('Remove the condition');
    expect(p.last().where).toBeNull();
    await p.click('＋ Condition', 1);
    expect(p.last().having!.items).toHaveLength(1);
    await p.click('Remove the condition');
    expect(p.last().having).toBeNull();
  });
});

describe('the canvas of the visual query builder', () => {
  it('joins two columns dragged onto each other and changes a join', async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [DbQueryCanvas],
    }).compileComponents();
    const fixture = TestBed.createComponent(DbQueryCanvas);
    const known = [
      { path: ['orders'], schema: 'public', name: 'orders', columns: ['id', 'user_id'], keys: [] },
      { path: ['users'], schema: 'public', name: 'users', columns: ['id'], keys: [] },
    ];
    fixture.componentRef.setInput('model', model);
    fixture.componentRef.setInput(
      'layout',
      builderLayout(model, known, (a, c) => `${a}.${c}`),
    );
    const joined: unknown[] = [];
    const kinds: number[] = [];
    fixture.componentInstance.joined.subscribe((link) => joined.push(link));
    fixture.componentInstance.kind.subscribe((table) => kinds.push(table));
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const columns = [...root.querySelectorAll<HTMLElement>('.qb-column')];
    const data = new Map<string, string>();
    const transfer = {
      types: ['application/x-nexo-column'],
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    };
    const event = (type: string) =>
      Object.assign(new Event(type, { cancelable: true }), { dataTransfer: transfer });
    columns[0].dispatchEvent(event('dragstart'));
    const over = event('dragover');
    columns[2].dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    columns[2].dispatchEvent(event('drop'));
    expect(joined).toEqual([
      { from: { table: 0, expression: 'o.id' }, to: { table: 1, expression: 'u.id' } },
    ]);
    data.clear();
    columns[1].dispatchEvent(event('drop'));
    expect(joined).toHaveLength(1);
    buttons(root, 'INNER')[0].click();
    expect(kinds).toEqual([1]);
    expect(root.querySelectorAll('svg line')).toHaveLength(1);
  });
});
