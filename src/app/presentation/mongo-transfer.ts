import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import type { TransferFailure } from '../application/mongo-use-cases';
import { formatBytes } from '../domain/mongo-indexes';
import { MongoTransferExport } from './mongo-transfer-export';
import { MongoTransferImport } from './mongo-transfer-import';
import type { TransferDraft } from './mongo-transfer/draft';
import { TYPE_LABELS } from './mongo-transfer/labels';
import type { MongoTransfers } from './mongo-transfer/transfers';

/**
 * The dialog of an import or export: its settings, then its progress with a way to cancel
 * it, then what it wrote and the documents that failed.
 */
@Component({
  imports: [TranslocoPipe, FormField, MongoTransferExport, MongoTransferImport],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-transfer',
  styleUrls: ['./mongo-dialog.scss', './mongo-transfer.scss'],
  templateUrl: './mongo-transfer.html',
  host: { '(keydown.escape)': 'escape()' },
})
export class MongoTransfer {
  readonly transfers = input.required<MongoTransfers>();
  readonly draft = input.required<TransferDraft>();
  protected readonly bytes = formatBytes;

  protected escape() {
    if (this.draft().phase() !== 'running') this.transfers().close();
  }
  /** The label of the button that runs the transfer. */
  protected runLabel(): string {
    const draft = this.draft();
    if (draft.direction === 'import') return 'Import';
    return draft.model().destination === 'collection' ? 'Copy' : 'Export';
  }
  /** A failure's message values, with the type of a CSV cell named. */
  protected failureType(failure: TransferFailure): string {
    return TYPE_LABELS[String(failure.params?.['v1'] ?? '')] ?? 'Number';
  }
}
