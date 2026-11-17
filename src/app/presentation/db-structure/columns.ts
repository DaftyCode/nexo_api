import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ColumnModel,
  addColumn,
  changeColumn,
  columnChanged,
  removeColumn,
} from '../../domain/db/structure';
import type { StructureDraft } from '../db-panel/structure-draft';

/**
 * The columns of a table, each cell edited in place as DBeaver's column editor: its name, its
 * type (a list of the server's types to search, the user's too), whether it takes `NULL`, its
 * default, its identity and its comment. Changed cells are marked until saved or reverted.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-structure-columns',
  template: `
    @let d = draft();
    <datalist [id]="typesId()">
      @for (type of d.types(); track type) {
        <option [value]="type"></option>
      }
    </datalist>
    <div class="db-structure-scroll">
      <table class="db-structure-table" [attr.aria-label]="'Columns' | transloco">
        <thead>
          <tr>
            <th scope="col">{{ 'Name' | transloco }}</th>
            <th scope="col">{{ 'Type' | transloco }}</th>
            <th scope="col">{{ 'Not null' | transloco }}</th>
            <th scope="col">{{ 'Default' | transloco }}</th>
            <th scope="col">{{ 'Identity' | transloco }}</th>
            <th scope="col">{{ 'Comment' | transloco }}</th>
            <th scope="col">
              <span class="db-hidden-text">{{ 'Actions' | transloco }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          @for (column of d.table().columns; track $index; let at = $index) {
            <tr [class.db-structure-new]="!column.original">
              <td [class.db-structure-changed]="changed(column, 'name')">
                <input
                  [value]="column.name"
                  [attr.aria-label]="'db.structure.name' | transloco: { v0: at + 1 }"
                  autocomplete="off"
                  spellcheck="false"
                  (change)="set(at, { name: text($event) })"
                />
              </td>
              <td [class.db-structure-changed]="changed(column, 'typeName')">
                <input
                  [value]="column.typeName"
                  [attr.list]="typesId()"
                  [attr.aria-label]="'db.structure.type' | transloco: { v0: column.name }"
                  autocomplete="off"
                  spellcheck="false"
                  (change)="set(at, { typeName: text($event) })"
                />
              </td>
              <td
                class="db-structure-check"
                [class.db-structure-changed]="changed(column, 'nullable')"
              >
                <input
                  type="checkbox"
                  [checked]="!column.nullable"
                  [attr.aria-label]="'db.structure.notNull' | transloco: { v0: column.name }"
                  (change)="set(at, { nullable: !checked($event) })"
                />
              </td>
              <td [class.db-structure-changed]="changed(column, 'default')">
                <input
                  [value]="column.default ?? ''"
                  [attr.aria-label]="'db.structure.default' | transloco: { v0: column.name }"
                  autocomplete="off"
                  spellcheck="false"
                  (change)="set(at, { default: text($event) || undefined })"
                />
              </td>
              <td
                class="db-structure-check"
                [class.db-structure-changed]="changed(column, 'identity')"
              >
                <input
                  type="checkbox"
                  [checked]="column.identity"
                  [attr.aria-label]="'db.structure.identity' | transloco: { v0: column.name }"
                  (change)="set(at, { identity: checked($event) })"
                />
              </td>
              <td [class.db-structure-changed]="changed(column, 'comment')">
                <input
                  [value]="column.comment ?? ''"
                  [attr.aria-label]="'db.structure.comment' | transloco: { v0: column.name }"
                  autocomplete="off"
                  (change)="set(at, { comment: text($event) || undefined })"
                />
              </td>
              <td>
                <button
                  type="button"
                  class="icon-button"
                  [attr.aria-label]="'db.structure.remove' | transloco: { v0: column.name }"
                  (click)="d.table.set(remove(at))"
                >
                  ×
                </button>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
    <button type="button" class="button small" (click)="d.table.set(add())">
      {{ 'Add column' | transloco }}
    </button>
  `,
  styleUrl: './structure.scss',
})
export class DbStructureColumns {
  readonly draft = input.required<StructureDraft>();
  /** One list of types per editor, named for its inputs. */
  protected readonly typesId = computed(() => `db-types-${this.draft().connection}`);

  protected changed(column: ColumnModel, field: keyof ColumnModel) {
    return !this.draft().creating && columnChanged(this.draft().original(), column, field);
  }
  protected set(at: number, change: Partial<ColumnModel>) {
    this.draft().table.update((table) => changeColumn(table, at, change));
  }
  protected add() {
    return addColumn(this.draft().table());
  }
  protected remove(at: number) {
    return removeColumn(this.draft().table(), at);
  }
  protected text(event: Event) {
    return (event.target as HTMLInputElement).value.trim();
  }
  protected checked(event: Event) {
    return (event.target as HTMLInputElement).checked;
  }
}
