import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  effect,
  untracked,
} from '@angular/core';
import {
  AUTHORIZATIONS,
  TASK_EVERY,
  TASK_TYPES,
  TaskForm,
  emptyTaskForm,
  taskProblem,
} from '../../domain/db/tasks';
import type { WorkspaceDocument } from '../../domain/models';
import { DbTaskTransferFields } from './transfer-fields';

/**
 * The editor of a database task (DB-31): its type and what it runs, what it authorizes when
 * nobody is there to confirm (with a warning), and when it runs on its own.
 */
@Component({
  imports: [TranslocoPipe, DbTaskTransferFields],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-task-form',
  templateUrl: './form.html',
  styles: `
    .task-form {
      display: flex;
      flex-direction: column;
      gap: var(--nexo-space-3);
    }
    .task-choices {
      display: flex;
      flex-wrap: wrap;
      gap: var(--nexo-space-1) var(--nexo-space-4);
      margin: 0;
      border: var(--nexo-border-width) solid var(--nexo-color-border-subtle);
      border-radius: var(--nexo-radius-sm);
    }
    .task-warning {
      color: var(--nexo-color-warning);
    }
  `,
})
export class DbTaskForm {
  readonly start = input<TaskForm>(emptyTaskForm());
  readonly connections = input.required<readonly WorkspaceDocument[]>();
  readonly scripts = input.required<readonly WorkspaceDocument[]>();
  /** The other tasks, to chain. */
  readonly tasks = input.required<readonly WorkspaceDocument[]>();
  /** Saved MongoDB transfers and comparisons, to run (DB-40). */
  readonly transfers = input<readonly WorkspaceDocument[]>([]);
  readonly comparisons = input<readonly WorkspaceDocument[]>([]);
  readonly saved = output<TaskForm>();
  readonly cancelled = output<void>();
  protected readonly form = signal<TaskForm>(emptyTaskForm());
  protected readonly types = TASK_TYPES;
  protected readonly authorizations = AUTHORIZATIONS;
  protected readonly every = TASK_EVERY;
  protected readonly problem = computed(() => taskProblem(this.form()));
  protected readonly authorizes = computed(() =>
    Object.values(this.form().authorize).some(Boolean),
  );

  constructor() {
    effect(() => {
      const start = this.start();
      untracked(() => this.form.set(structuredClone(start)));
    });
  }

  protected set(patch: Partial<TaskForm>) {
    this.form.update((form) => ({ ...form, ...patch }));
  }
  protected value(event: Event) {
    return (event.target as HTMLInputElement).value;
  }
  /** Adds or takes away an id of a list (scripts, connections, tasks). */
  protected toggle(key: 'scripts' | 'connections' | 'tasks', id: string) {
    const list = this.form()[key];
    this.set({ [key]: list.includes(id) ? list.filter((each) => each !== id) : [...list, id] });
  }
  protected allow(key: (typeof AUTHORIZATIONS)[number]) {
    const authorize = { ...this.form().authorize, [key]: !this.form().authorize[key] };
    this.set({ authorize });
  }
  /** Every some minutes, by hand (0) or on a cron expression (-1). */
  protected schedule(minutes: number) {
    this.set(
      minutes < 0
        ? { every: 0, cron: this.form().cron || '0 9 * * *' }
        : { every: minutes, cron: '' },
    );
  }
  protected everyLabel(minutes: number) {
    return minutes === 0
      ? 'db.task.byHand'
      : minutes >= 60
        ? 'db.task.everyHours'
        : 'db.task.everyMinutes';
  }
  protected save() {
    if (!this.problem()) this.saved.emit(this.form());
  }
}
