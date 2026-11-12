import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { formatBytes } from '../domain/mongo-indexes';
import { IMPORT_TYPES, ImportType } from '../domain/mongo-transfer';
import { MongoTransferWrite } from './mongo-transfer-write';
import type { TransferDraft } from './mongo-transfer/draft';
import { TYPE_LABELS } from './mongo-transfer/labels';
import type { MongoTransfers } from './mongo-transfer/transfers';

/**
 * The file an import reads, its first documents, the columns of a CSV with the field and
 * type of each one, and the collection written.
 */
@Component({
  imports: [TranslocoPipe, FormField, MongoTransferWrite],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-transfer-import',
  styleUrls: ['./mongo-dialog.scss', './mongo-transfer.scss'],
  templateUrl: './mongo-transfer-import.html',
})
export class MongoTransferImport {
  readonly transfers = input.required<MongoTransfers>();
  readonly draft = input.required<TransferDraft>();
  protected readonly bytes = formatBytes;
  protected readonly types = IMPORT_TYPES;
  protected readonly typeLabels = TYPE_LABELS;

  protected json(document: unknown) {
    return JSON.stringify(document);
  }
  /** The first values of a column, to recognise it. */
  protected firstValues(rows: readonly string[][], column: number) {
    return rows
      .slice(0, 3)
      .map((row) => row[column] ?? '')
      .join(' · ');
  }
  protected setField(index: number, event: Event) {
    this.draft().setColumn(index, { field: (event.target as HTMLInputElement).value });
  }
  protected setType(index: number, event: Event) {
    this.draft().setColumn(index, {
      type: (event.target as HTMLSelectElement).value as ImportType,
    });
  }
}
