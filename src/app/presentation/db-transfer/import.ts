import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { IMPORT_KINDS, ImportKind } from '../../domain/db/transfer/import';
import type { TransferDraft } from '../db-panel/transfer-draft';

/**
 * The file of an import: chosen, read as CSV or JSON, its first rows shown, and each of its
 * columns sent to a column of the table (or of a table created from it) with its kind.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-transfer-import',
  template: `
    @let d = draft();
    @let fields = d.fields;
    @let model = d.model();
    <div class="row">
      <button type="button" class="button" (click)="choose()">
        {{ (d.file() ? 'Choose another file' : 'Choose a file') | transloco }}
      </button>
      <span class="muted">{{ d.file()?.name }}</span>
    </div>
    @if (d.file()) {
      <div class="db-transfer-grid">
        <label class="field"
          >{{ 'Format' | transloco }}
          <select [formField]="fields.fileFormat" (change)="reread()">
            <option value="csv">CSV</option>
            <option value="json">{{ 'JSON or JSON Lines' | transloco }}</option>
          </select>
        </label>
        @if (model.fileFormat === 'csv') {
          <label class="field"
            >{{ 'Separator' | transloco }}
            <select [formField]="fields.separator" (change)="reread()">
              <option value=",">,</option>
              <option value=";">;</option>
              <option [value]="tab">{{ 'Tab' | transloco }}</option>
              <option value="|">|</option>
            </select>
          </label>
          <label class="check-field"
            ><input type="checkbox" [formField]="fields.header" (change)="reread()" />{{
              'A first line with the column names' | transloco
            }}</label
          >
        }
        @if (d.request.table) {
          <label class="check-field"
            ><input type="checkbox" [formField]="fields.newTable" (change)="reread()" />{{
              'Into a new table' | transloco
            }}</label
          >
        }
        @if (model.newTable) {
          <label class="field"
            >{{ 'New table' | transloco }}<input [formField]="fields.table" autocomplete="off"
          /></label>
        }
        <label class="check-field"
          ><input type="checkbox" [formField]="fields.trim" />{{ 'Trim spaces' | transloco }}</label
        >
        <label class="check-field"
          ><input type="checkbox" [formField]="fields.emptyAsNull" />{{
            'An empty cell is NULL' | transloco
          }}</label
        >
      </div>
      <div class="db-transfer-scroll">
        <table class="db-transfer-table" [attr.aria-label]="'Columns of the file' | transloco">
          <thead>
            <tr>
              <th scope="col">{{ 'File column' | transloco }}</th>
              <th scope="col">{{ 'Kind' | transloco }}</th>
              <th scope="col">{{ 'Goes to' | transloco }}</th>
              @for (row of d.preview(); track $index) {
                <th scope="col">{{ 'db.transfer.row' | transloco: { v0: $index + 1 } }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (column of d.columns(); track $index; let at = $index) {
              <tr>
                <th scope="row">{{ column.name }}</th>
                <td>
                  <select
                    [attr.aria-label]="'db.transfer.kindOf' | transloco: { v0: column.name }"
                    (change)="d.setColumn(at, { kind: kind($event) })"
                  >
                    @for (each of kinds; track each) {
                      <option [value]="each" [selected]="each === column.kind">
                        {{ 'db.transfer.kind.' + each | transloco }}
                      </option>
                    }
                  </select>
                </td>
                <td>
                  @if (model.newTable) {
                    <input
                      [attr.aria-label]="'db.transfer.targetOf' | transloco: { v0: column.name }"
                      [value]="column.target"
                      (change)="d.setColumn(at, { target: text($event) })"
                    />
                  } @else {
                    <select
                      [attr.aria-label]="'db.transfer.targetOf' | transloco: { v0: column.name }"
                      (change)="d.setColumn(at, { target: text($event) })"
                    >
                      <option value="" [selected]="!column.target">
                        {{ 'Skip it' | transloco }}
                      </option>
                      @for (target of d.tableColumns(); track target.name) {
                        <option [value]="target.name" [selected]="target.name === column.target">
                          {{ target.name }}
                        </option>
                      }
                    </select>
                  }
                </td>
                @for (row of d.preview(); track $index) {
                  <td>{{ row[at] }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styleUrl: './transfer.scss',
})
export class DbTransferImport {
  readonly draft = input.required<TransferDraft>();
  protected readonly kinds = IMPORT_KINDS;
  protected readonly tab = '\t';

  protected choose() {
    void this.draft().run.chooseFile();
  }
  protected reread() {
    // The form updates its model first.
    queueMicrotask(() => void this.draft().run.readPreview());
  }
  protected kind(event: Event) {
    return (event.target as HTMLSelectElement).value as ImportKind;
  }
  protected text(event: Event) {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
}
