import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  untracked,
} from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { MongoTransferWrite } from './mongo-transfer-write';
import type { TransferDraft } from './mongo-transfer/draft';
import type { MongoTransfers } from './mongo-transfer/transfers';

/**
 * What an export reads and where it goes: a JSON, JSON Lines or CSV file, or another
 * collection; for a CSV, the fields written and their order.
 */
@Component({
  imports: [TranslocoPipe, FormField, MongoTransferWrite],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-transfer-export',
  styleUrls: ['./mongo-dialog.scss', './mongo-transfer.scss'],
  templateUrl: './mongo-transfer-export.html',
})
export class MongoTransferExport {
  readonly transfers = input.required<MongoTransfers>();
  readonly draft = input.required<TransferDraft>();
  /** The query exported, as typed in the bar. */
  protected readonly queryText = computed(() =>
    Object.entries(this.draft().query)
      .filter(([, text]) => text.trim())
      .map(([field, text]) => `${field}: ${text.trim()}`)
      .join('\n'),
  );
  /** The fields found that the CSV does not write. */
  protected readonly left = computed(() => {
    const chosen = new Set(this.draft().chosen());
    return this.draft()
      .available()
      .filter((field) => !chosen.has(field));
  });

  constructor() {
    // A CSV names its columns: the fields of the first documents are found once.
    effect(() => {
      const draft = this.draft();
      if (draft.model().format !== 'csv' || draft.model().destination !== 'file') return;
      untracked(() => {
        if (!draft.available().length) void this.transfers().loadFields(draft);
      });
    });
  }
}
