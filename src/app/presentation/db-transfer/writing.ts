import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import type { TransferDraft } from '../db-panel/transfer-draft';

/**
 * How rows are written into the target table: inserted, or inserted or updated by their
 * key; the table emptied first after typing its name; and whether the first failure stops
 * all of it (one transaction, undone) or the failed rows are only said.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-transfer-writing',
  template: `
    @let d = draft();
    @let fields = d.fields;
    @let model = d.model();
    <div class="db-transfer-grid">
      <label class="field"
        >{{ 'Rows are' | transloco }}
        <select [formField]="fields.mode">
          <option value="insert">{{ 'Inserted' | transloco }}</option>
          <option value="upsert">{{ 'Inserted or updated by their key' | transloco }}</option>
        </select>
      </label>
      <label class="check-field"
        ><input type="checkbox" [formField]="fields.stopOnError" />{{
          'Stop at the first failure and undo it all' | transloco
        }}</label
      >
      <label class="check-field"
        ><input type="checkbox" [formField]="fields.clear" />{{
          'Empty the table first' | transloco
        }}</label
      >
      @if (model.clear) {
        <label class="field"
          >{{ 'db.transfer.typeName' | transloco: { v0: model.table }
          }}<input [formField]="fields.clearName" autocomplete="off"
        /></label>
      }
    </div>
    @if (model.mode === 'upsert') {
      <fieldset class="db-transfer-keys">
        <legend>{{ 'The columns that name a row' | transloco }}</legend>
        @for (column of d.keyChoices(); track column) {
          <label class="check-field"
            ><input
              type="checkbox"
              [checked]="d.key().has(column)"
              (change)="d.toggleKey(column)"
            />{{ column }}</label
          >
        }
      </fieldset>
    }
  `,
  styleUrl: './transfer.scss',
})
export class DbTransferWriting {
  readonly draft = input.required<TransferDraft>();
}
