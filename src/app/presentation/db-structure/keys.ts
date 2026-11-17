import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FOREIGN_ACTIONS, TableModel } from '../../domain/db/structure';
import type { StructureDraft } from '../db-panel/structure-draft';

/** `a, b DESC` → `["a", "b DESC"]`. */
const names = (text: string) =>
  text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

/**
 * The keys of a table: its primary key, unique and `CHECK` constraints, foreign keys (the
 * table and columns they point to, and what a delete or an update does) and indexes (their
 * columns in order, unique, method and condition). Lists of columns are written separated by
 * commas, `DESC` after one that goes down.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-structure-keys',
  template: `
    @let table = draft().table();
    <label class="field"
      >{{ 'Primary key (columns)' | transloco
      }}<input
        [value]="table.primaryKey?.columns?.join(', ') ?? ''"
        autocomplete="off"
        (change)="update({ primaryKey: keyOf(text($event), table.primaryKey?.name) })"
    /></label>
    <h3>{{ 'Unique and check constraints' | transloco }}</h3>
    <ul class="db-structure-list">
      @for (key of table.uniques; track $index; let at = $index) {
        <li class="db-structure-item">
          <label class="field"
            >{{ 'Name' | transloco
            }}<input [value]="key.name ?? ''" (change)="uniques(at, { name: text($event) })"
          /></label>
          <label class="field grow"
            >{{ 'Unique columns' | transloco
            }}<input
              [value]="key.columns.join(', ')"
              (change)="uniques(at, { columns: list($event) })"
          /></label>
          <button
            type="button"
            class="icon-button"
            [attr.aria-label]="'Remove' | transloco"
            (click)="update({ uniques: without(table.uniques, at) })"
          >
            ×
          </button>
        </li>
      }
      @for (check of table.checks; track $index; let at = $index) {
        <li class="db-structure-item">
          <label class="field"
            >{{ 'Name' | transloco
            }}<input [value]="check.name ?? ''" (change)="checks(at, { name: text($event) })"
          /></label>
          <label class="field grow"
            >{{ 'Check' | transloco
            }}<input
              [value]="check.expression"
              spellcheck="false"
              (change)="checks(at, { expression: text($event) })"
          /></label>
          <button
            type="button"
            class="icon-button"
            [attr.aria-label]="'Remove' | transloco"
            (click)="update({ checks: without(table.checks, at) })"
          >
            ×
          </button>
        </li>
      }
    </ul>
    <div class="row">
      <button
        type="button"
        class="button small"
        (click)="update({ uniques: [...table.uniques, { columns: [] }] })"
      >
        {{ 'Add unique' | transloco }}
      </button>
      <button
        type="button"
        class="button small"
        (click)="update({ checks: [...table.checks, { expression: '' }] })"
      >
        {{ 'Add check' | transloco }}
      </button>
    </div>
    <h3>{{ 'Foreign keys' | transloco }}</h3>
    <ul class="db-structure-list">
      @for (key of table.foreignKeys; track $index; let at = $index) {
        <li class="db-structure-item">
          <label class="field"
            >{{ 'Name' | transloco
            }}<input [value]="key.name ?? ''" (change)="foreign(at, { name: text($event) })"
          /></label>
          <label class="field"
            >{{ 'Foreign key columns' | transloco
            }}<input
              [value]="key.columns.join(', ')"
              (change)="foreign(at, { columns: list($event) })"
          /></label>
          <label class="field"
            >{{ 'Referenced table' | transloco
            }}<input
              [value]="key.referencedTable"
              (change)="foreign(at, { referencedTable: text($event) })"
          /></label>
          <label class="field"
            >{{ 'Referenced columns' | transloco
            }}<input
              [value]="key.referencedColumns.join(', ')"
              (change)="foreign(at, { referencedColumns: list($event) })"
          /></label>
          @for (event of ['onDelete', 'onUpdate']; track event) {
            <label class="field"
              >{{ (event === 'onDelete' ? 'On delete' : 'On update') | transloco }}
              <select (change)="foreignAction(at, event, text($event))">
                @for (action of actions; track action) {
                  <option [value]="action" [selected]="actionOf(key, event) === action">
                    {{ action || 'NO ACTION' }}
                  </option>
                }
              </select>
            </label>
          }
          <button
            type="button"
            class="icon-button"
            [attr.aria-label]="'Remove' | transloco"
            (click)="update({ foreignKeys: without(table.foreignKeys, at) })"
          >
            ×
          </button>
        </li>
      }
    </ul>
    <button
      type="button"
      class="button small"
      (click)="
        update({
          foreignKeys: [
            ...table.foreignKeys,
            { columns: [], referencedTable: '', referencedColumns: [] },
          ],
        })
      "
    >
      {{ 'Add foreign key' | transloco }}
    </button>
    <h3>{{ 'Indexes' | transloco }}</h3>
    <ul class="db-structure-list">
      @for (index of table.indexes; track $index; let at = $index) {
        <li class="db-structure-item">
          <label class="field"
            >{{ 'Name' | transloco
            }}<input [value]="index.name" (change)="indexes(at, { name: text($event) })"
          /></label>
          <label class="field grow"
            >{{ 'Index columns' | transloco
            }}<input
              [value]="index.columns.join(', ')"
              (change)="indexes(at, { columns: list($event) })"
          /></label>
          <label class="check-field"
            ><input
              type="checkbox"
              [checked]="index.unique"
              (change)="indexes(at, { unique: $any($event.target).checked })"
            />{{ 'Unique' | transloco }}</label
          >
          <label class="field"
            >{{ 'Method' | transloco
            }}<input
              [value]="index.method ?? ''"
              placeholder="btree"
              (change)="indexes(at, { method: text($event) })"
          /></label>
          <label class="field"
            >{{ 'Condition' | transloco
            }}<input
              [value]="index.condition ?? ''"
              spellcheck="false"
              (change)="indexes(at, { condition: text($event) })"
          /></label>
          <button
            type="button"
            class="icon-button"
            [attr.aria-label]="'Remove' | transloco"
            (click)="update({ indexes: without(table.indexes, at) })"
          >
            ×
          </button>
        </li>
      }
    </ul>
    <button type="button" class="button small" (click)="addIndex()">
      {{ 'Add index' | transloco }}
    </button>
  `,
  styleUrl: './structure.scss',
})
export class DbStructureKeys {
  readonly draft = input.required<StructureDraft>();
  protected readonly actions = FOREIGN_ACTIONS;

  protected update(change: Partial<TableModel>) {
    this.draft().table.update((table) => ({ ...table, ...change }));
  }
  protected text(event: Event) {
    return (event.target as HTMLInputElement | HTMLSelectElement).value.trim();
  }
  protected list(event: Event) {
    return names(this.text(event));
  }
  protected keyOf(text: string, name?: string) {
    const columns = names(text);
    return columns.length ? { ...(name ? { name } : {}), columns } : undefined;
  }
  protected without<T>(items: readonly T[], at: number) {
    return items.filter((_, i) => i !== at);
  }
  private replace<K extends 'uniques' | 'checks' | 'foreignKeys' | 'indexes'>(
    list: K,
    at: number,
    change: Partial<TableModel[K][number]>,
  ) {
    this.draft().table.update((table) => ({
      ...table,
      [list]: (table[list] as TableModel[K][number][]).map((item, i) =>
        i === at ? { ...item, ...change } : item,
      ),
    }));
  }
  protected uniques(at: number, change: Partial<TableModel['uniques'][number]>) {
    this.replace('uniques', at, change);
  }
  protected checks(at: number, change: Partial<TableModel['checks'][number]>) {
    this.replace('checks', at, change);
  }
  protected foreign(at: number, change: Partial<TableModel['foreignKeys'][number]>) {
    this.replace('foreignKeys', at, change);
  }
  protected indexes(at: number, change: Partial<TableModel['indexes'][number]>) {
    this.replace('indexes', at, change);
  }
  protected actionOf(key: TableModel['foreignKeys'][number], event: string) {
    return (event === 'onDelete' ? key.onDelete : key.onUpdate) ?? '';
  }
  protected foreignAction(at: number, event: string, action: string) {
    this.foreign(at, event === 'onDelete' ? { onDelete: action } : { onUpdate: action });
  }
  protected addIndex() {
    const table = this.draft().table();
    this.update({
      indexes: [
        ...table.indexes,
        { name: `${table.name}_index${table.indexes.length + 1}`, columns: [], unique: false },
      ],
    });
  }
}
