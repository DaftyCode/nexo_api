import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import {
  AGGREGATES,
  COMPARISONS,
  ConditionGroup,
  JOIN_KINDS,
  QueryModel,
} from '../../domain/db/query-model';
import { DbQueryGroup } from './group';

type Panel = 'columns' | 'conditions' | 'grouping' | 'order' | 'joins' | 'page';
const AGGREGATE_NAMES: Record<string, string> = {
  '': 'No aggregate',
  count: 'Count',
  'count-distinct': 'Count distinct',
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
};

/** Moves the item at `at` one place up or down. */
function moved<T>(items: readonly T[], at: number, by: -1 | 1): T[] {
  const to = at + by;
  if (to < 0 || to >= items.length) return [...items];
  const copy = [...items];
  [copy[at], copy[to]] = [copy[to], copy[at]];
  return copy;
}

/**
 * The panels under the canvas of the visual query builder, as editable lists: columns (with
 * an alias and an aggregate), conditions, grouping, order, joins and the page. They do all
 * the canvas does, with the keyboard.
 */
@Component({
  imports: [TranslocoPipe, DbQueryGroup],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-query-panels',
  templateUrl: './panels.html',
  styleUrl: './panels.scss',
})
export class DbQueryPanels {
  readonly model = input.required<QueryModel>();
  readonly readOnly = input(false);
  readonly changed = output<QueryModel>();
  protected readonly panel = signal<Panel>('columns');
  protected readonly panels: readonly [Panel, string][] = [
    ['columns', 'Columns'],
    ['conditions', 'Conditions'],
    ['grouping', 'Grouping'],
    ['order', 'Order'],
    ['joins', 'Joins'],
    ['page', 'Page'],
  ];
  protected readonly aggregates = AGGREGATES.map((value) => [value, AGGREGATE_NAMES[value]]);
  protected readonly kinds = JOIN_KINDS;
  protected readonly comparisons = COMPARISONS;
  protected readonly moved = moved;
  protected replaceAt<T>(items: readonly T[], at: number, item: T): T[] {
    return items.map((each, index) => (index === at ? item : each));
  }

  protected set(patch: Partial<QueryModel>) {
    this.changed.emit({ ...this.model(), ...patch });
  }
  protected list<K extends 'columns' | 'orderBy' | 'groupBy' | 'joins'>(
    key: K,
    at: number,
    item: QueryModel[K][number],
  ) {
    const items = [...this.model()[key]] as QueryModel[K][number][];
    items[at] = item;
    this.set({ [key]: items } as Partial<QueryModel>);
  }
  protected without<K extends 'columns' | 'orderBy' | 'groupBy' | 'joins'>(key: K, at: number) {
    const items = (this.model()[key] as unknown[]).filter((_, index) => index !== at);
    this.set({ [key]: items } as Partial<QueryModel>);
  }
  protected where(group: ConditionGroup) {
    this.set({ where: group.items.length ? group : null });
  }
  protected having(group: ConditionGroup) {
    this.set({ having: group.items.length ? group : null });
  }
  /** Every column chosen without an aggregate, as the grouping. */
  protected groupByChosen() {
    this.set({
      groupBy: this.model()
        .columns.filter((column) => !column.aggregate && column.expression !== '*')
        .map((column) => column.expression),
    });
  }
  protected count(text: string): number | null {
    const value = Number(text);
    return text.trim() && Number.isInteger(value) && value >= 0 ? value : null;
  }
  protected aliasOf(table: number) {
    const found = this.model().tables[table];
    return found ? found.alias || found.path.join('.') : '';
  }
  protected readonly empty: ConditionGroup = { match: 'all', items: [] };
}
