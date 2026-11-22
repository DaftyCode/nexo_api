import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { TaskForm } from '../../domain/db/tasks';
import { FILE_FORMATS } from '../../domain/db/tasks/transfer';
import type { WorkspaceDocument } from '../../domain/models';

/**
 * The fields of the tasks with files and MongoDB (DB-40): a query to a file, a file into a
 * table, a saved MongoDB transfer and a saved MongoDB comparison.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-task-transfer-fields',
  templateUrl: './transfer-fields.html',
})
export class DbTaskTransferFields {
  readonly form = input.required<TaskForm>();
  readonly connections = input.required<readonly WorkspaceDocument[]>();
  readonly transfers = input<readonly WorkspaceDocument[]>([]);
  readonly comparisons = input<readonly WorkspaceDocument[]>([]);
  readonly patch = output<Partial<TaskForm>>();
  protected readonly formats = FILE_FORMATS;
  /** The saved transfer chosen, and whether it reads or writes a file. */
  protected readonly transfer = computed(() =>
    this.transfers().find((document) => document.id === this.form().transfer),
  );
  protected readonly withFile = computed(() => {
    const value = (this.transfer()?.value ?? {}) as Record<string, unknown>;
    return value['direction'] === 'import' || value['destination'] !== 'collection';
  });
  protected readonly importing = computed(
    () =>
      (this.transfer()?.value as Record<string, unknown> | undefined)?.['direction'] === 'import',
  );
  protected readonly files = computed(
    () =>
      this.form().type === 'export' ||
      this.form().type === 'import' ||
      (this.form().type === 'mongo-transfer' && !!this.transfer() && this.withFile()),
  );

  protected value(event: Event) {
    return (event.target as HTMLInputElement).value;
  }
  protected checked(event: Event) {
    return (event.target as HTMLInputElement).checked;
  }
}
