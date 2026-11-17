import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { TRANSFER_FILES } from '../composition/providers';
import { DbSection } from './db-panel/section';
import { TransferDraft } from './db-panel/transfer-draft';
import type { TransferRequest } from './db-panel/transfer-request';
import { DbTransferCopy } from './db-transfer/copy';
import { DbTransferExport } from './db-transfer/export';
import { DbTransferImport } from './db-transfer/import';
import { DbTransferWriting } from './db-transfer/writing';

/**
 * The data transfer wizard, as DBeaver's: what is exported and how, the file imported and
 * where each of its columns goes, or the connection a table is copied to; how the rows are
 * written; then the run, with its progress, a cancel, and what happened.
 */
@Component({
  imports: [TranslocoPipe, DbTransferExport, DbTransferImport, DbTransferCopy, DbTransferWriting],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-transfer',
  templateUrl: './db-transfer.html',
  styleUrl: './db-transfer.scss',
})
export class DbTransfer {
  readonly request = input.required<TransferRequest>();
  readonly closed = output<void>();
  private readonly section = inject(DbSection);
  private readonly files = inject(TRANSFER_FILES);
  private readonly injector = inject(Injector);
  /** One draft per request: its form makes effects, so it is built outside the computed. */
  protected readonly draft = computed(() => {
    const request = this.request();
    return untracked(() => new TransferDraft(this.section, request, this.files, this.injector));
  });
  protected readonly title = computed(
    () =>
      ({
        export: 'Export data',
        import: 'Import data',
        copy: 'Copy to another connection',
      })[this.request().kind],
  );
  /** Whether the run can start: a file chosen, a target chosen, the typed table name. */
  protected readonly ready = computed(() => {
    const draft = this.draft();
    const model = draft.model();
    if (!draft.clearReady()) return false;
    if (model.mode === 'upsert' && !draft.key().size && this.request().kind !== 'export')
      return false;
    switch (this.request().kind) {
      case 'export':
        return true;
      case 'import':
        return !!draft.file() && draft.columns().some((column) => column.target);
      case 'copy':
        return !!model.target && !!model.table.trim();
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.draft().run.cancel();
      void this.draft().run.close();
    });
  }

  protected percent() {
    const { bytes, total } = this.draft().progress();
    return total ? Math.round((bytes / total) * 100) : undefined;
  }
  protected close() {
    if (this.draft().phase() === 'running') this.draft().run.cancel();
    this.closed.emit();
  }
}
