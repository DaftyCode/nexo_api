import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import {
  CONDITION_OPERATORS,
  Condition,
  ConditionGroup,
  ConditionOperator,
  ValueKind,
  isGroup,
  operatorValues,
} from '../../domain/db/query-model';

const blank = (): Condition => ({
  column: '',
  operator: '=',
  values: [{ text: '', kind: 'text' }],
});

/**
 * A group of conditions of `WHERE` or `HAVING`: «all» or «any» of its conditions and of the
 * groups inside it, each one edited in place. Values are written as text, a number or an
 * expression; text is escaped as a string of the dialect.
 */
@Component({
  imports: [TranslocoPipe, DbQueryGroup],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-query-group',
  template: `
    @let g = group();
    <div class="qb-group" role="group" [attr.aria-label]="'Conditions' | transloco">
      <select
        [attr.aria-label]="'Match' | transloco"
        [disabled]="readOnly()"
        [value]="g.match"
        (change)="set({ ...g, match: $any($event.target).value })"
      >
        <option value="all">{{ 'All of these' | transloco }}</option>
        <option value="any">{{ 'Any of these' | transloco }}</option>
      </select>
      @for (item of g.items; track $index; let at = $index) {
        @if (isGroup(item)) {
          <div class="qb-nested">
            <app-db-query-group
              [group]="item"
              [readOnly]="readOnly()"
              (changed)="replace(at, $event)"
            />
            <button
              type="button"
              class="text-button danger"
              [disabled]="readOnly()"
              (click)="drop(at)"
            >
              {{ 'Remove the group' | transloco }}
            </button>
          </div>
        } @else {
          <div class="qb-row">
            <input
              [value]="item.column"
              [disabled]="readOnly()"
              [attr.aria-label]="'Column or expression' | transloco"
              spellcheck="false"
              (change)="replace(at, { ...item, column: $any($event.target).value })"
            />
            <select
              [value]="item.operator"
              [disabled]="readOnly()"
              [attr.aria-label]="'Operator' | transloco"
              (change)="operator(at, item, $any($event.target).value)"
            >
              @for (each of operators; track each) {
                <option [value]="each">{{ each.toUpperCase() }}</option>
              }
            </select>
            @for (value of item.values; track $index; let v = $index) {
              <input
                [value]="value.text"
                [disabled]="readOnly()"
                [attr.aria-label]="'Value' | transloco"
                spellcheck="false"
                (change)="value_(at, item, v, { ...value, text: $any($event.target).value })"
              />
              <select
                [value]="value.kind"
                [disabled]="readOnly()"
                [attr.aria-label]="'Kind of value' | transloco"
                (change)="value_(at, item, v, { ...value, kind: $any($event.target).value })"
              >
                @for (kind of kinds; track kind[0]) {
                  <option [value]="kind[0]">{{ kind[1] | transloco }}</option>
                }
              </select>
            }
            @if (item.operator === 'in' || item.operator === 'not in') {
              <button
                type="button"
                class="text-button"
                [disabled]="readOnly()"
                (click)="more(at, item)"
              >
                {{ '＋ Value' | transloco }}
              </button>
            }
            <button
              type="button"
              class="icon-button"
              [disabled]="readOnly()"
              [attr.aria-label]="'Remove the condition' | transloco"
              (click)="drop(at)"
            >
              ×
            </button>
          </div>
        }
      }
      <div class="button-grid">
        <button type="button" class="text-button" [disabled]="readOnly()" (click)="add(blank())">
          {{ '＋ Condition' | transloco }}
        </button>
        <button
          type="button"
          class="text-button"
          [disabled]="readOnly()"
          (click)="add({ match: g.match === 'all' ? 'any' : 'all', items: [blank()] })"
        >
          {{ '＋ Group' | transloco }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .qb-group {
      display: flex;
      flex-direction: column;
      gap: var(--nexo-space-2);
    }
    .qb-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--nexo-space-2);
      align-items: center;
    }
    .qb-nested {
      margin-left: var(--nexo-space-5);
      padding-left: var(--nexo-space-3);
      border-left: var(--nexo-border-width-strong) solid var(--nexo-color-border);
    }
  `,
})
export class DbQueryGroup {
  readonly group = input.required<ConditionGroup>();
  readonly readOnly = input(false);
  readonly changed = output<ConditionGroup>();
  protected readonly operators = CONDITION_OPERATORS;
  protected readonly kinds: readonly [ValueKind, string][] = [
    ['text', 'Text'],
    ['number', 'Number'],
    ['expression', 'Expression'],
  ];
  protected readonly isGroup = isGroup;
  protected readonly blank = blank;

  protected set(group: ConditionGroup) {
    this.changed.emit(group);
  }
  protected replace(at: number, item: Condition | ConditionGroup) {
    const items = [...this.group().items];
    items[at] = item;
    this.set({ ...this.group(), items });
  }
  protected drop(at: number) {
    this.set({ ...this.group(), items: this.group().items.filter((_, index) => index !== at) });
  }
  protected add(item: Condition | ConditionGroup) {
    this.set({ ...this.group(), items: [...this.group().items, item] });
  }
  /** Another operator, with as many values as it takes. */
  protected operator(at: number, item: Condition, operator: ConditionOperator) {
    const wanted = operatorValues(operator);
    const values = [...item.values];
    while (values.length < wanted) values.push({ text: '', kind: 'text' });
    this.replace(at, {
      ...item,
      operator,
      values: operator === 'in' || operator === 'not in' ? values : values.slice(0, wanted),
    });
  }
  protected value_(at: number, item: Condition, index: number, value: Condition['values'][number]) {
    const values = [...item.values];
    values[index] = value;
    this.replace(at, { ...item, values });
  }
  protected more(at: number, item: Condition) {
    this.replace(at, { ...item, values: [...item.values, { text: '', kind: 'text' }] });
  }
}
