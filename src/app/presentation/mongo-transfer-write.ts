import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import type { TransferDraft } from './mongo-transfer/draft';

/**
 * How an import or copy writes: inserted, replaced by key fields, or into a collection
 * emptied first after its name is typed; and whether it stops at the first failure.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-transfer-write',
  styleUrls: ['./mongo-dialog.scss', './mongo-transfer.scss'],
  template: `
    <fieldset class="mongo-options">
      <legend>{{ 'How documents are written' | transloco }}</legend>
      <label class="field"
        >{{ 'Mode' | transloco }}
        <select [formField]="draft().fields.mode">
          <option value="insert">{{ 'Insert' | transloco }}</option>
          <option value="upsert">{{ 'Replace by key fields (upsert)' | transloco }}</option>
          <option value="replace">{{ 'Empty the collection first' | transloco }}</option>
        </select>
      </label>
      @switch (draft().model().mode) {
        @case ('insert') {
          <p class="mongo-transfer-hint">
            {{ 'A document whose _id is already there fails, and the rest go on.' | transloco }}
          </p>
        }
        @case ('upsert') {
          <label class="field"
            >{{ 'Key fields, separated by commas' | transloco
            }}<input
              [formField]="draft().fields.keyText"
              placeholder="_id"
              spellcheck="false"
              autocomplete="off"
          /></label>
          <p class="mongo-transfer-hint">
            {{
              'The document with the same values in these fields is replaced; if none has them, it is added.'
                | transloco
            }}
          </p>
        }
        @case ('replace') {
          <p class="mongo-warning">
            {{ 'mongo.transfer.emptyFirst' | transloco: { v0: collection() } }}
          </p>
          <label class="field"
            >{{ 'mongo.typeName' | transloco: { v0: collection() }
            }}<input [formField]="draft().fields.confirm" autocomplete="off" spellcheck="false"
          /></label>
        }
      }
      <label class="check-field"
        ><input type="checkbox" [formField]="draft().fields.continueOnError" />{{
          'Go on after a document fails' | transloco
        }}</label
      >
    </fieldset>
  `,
})
export class MongoTransferWrite {
  readonly draft = input.required<TransferDraft>();
  /** The collection written, whose name confirms emptying it. */
  readonly collection = input.required<string>();
}
