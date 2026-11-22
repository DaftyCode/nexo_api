import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import type { TaskState } from '../application/database-use-cases';
import { isDbConnection } from '../domain/db/connection';
import {
  TaskForm,
  authorizes,
  emptyTaskForm,
  taskForm,
  taskValue,
  type TaskRun,
} from '../domain/db/tasks';
import type { WorkspaceDocument } from '../domain/models';
import { DbSection } from './db-panel/section';
import { DbTaskForm } from './db-tasks/form';
import { PanelTask } from './panel-task';
import { success } from './workspace-state';

/**
 * «Tasks» of the database section (DB-31): every saved task of the workspace by folder, with
 * its last run and when it runs next, to run, edit, duplicate or delete; its history, and the
 * editor of a new one. Scheduled tasks run only while Nexo is open.
 */
@Component({
  imports: [TranslocoPipe, DatePipe, DbTaskForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-tasks',
  templateUrl: './db-tasks.html',
  styleUrl: './db-tasks.scss',
})
export class DbTasks {
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  private readonly documents = computed(() => this.section.state.documents());
  protected readonly tasks = computed(() =>
    this.documents()
      .filter((document) => document.kind === 'db-task')
      .sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.name.localeCompare(b.name)),
  );
  protected readonly connections = computed(() => this.documents().filter(isDbConnection));
  protected readonly scripts = computed(() =>
    this.documents().filter((d) => d.kind === 'sql-script'),
  );
  /** The task in the editor: its id, `new`, or none; and what the editor starts from. */
  protected readonly editing = signal<string | undefined>(undefined);
  protected readonly start = signal<TaskForm>(emptyTaskForm());
  protected readonly shown = signal<string | undefined>(undefined);
  protected readonly states = signal<Readonly<Record<string, TaskState>>>({});
  /** The last runs of each task, newest first, read again after each run. */
  protected readonly histories = signal<Readonly<Record<string, TaskRun[]>>>({});
  protected readonly authorizes = authorizes;
  protected readonly folderOf = folderOf;

  constructor() {
    void this.refresh();
  }

  private async refresh() {
    const cases = (await this.section.cases()).tasks;
    const states = await cases.states(this.section.state.workspaceId()).catch(() => []);
    this.states.set(Object.fromEntries(states.map((state) => [state.id, state])));
    const histories = await Promise.all(
      this.tasks().map(async (task) => [task.id, await cases.history(task.id).catch(() => [])]),
    );
    this.histories.set(Object.fromEntries(histories));
  }
  protected runs(id: string) {
    return this.histories()[id] ?? [];
  }
  protected lastRun(id: string) {
    return this.runs(id)[0];
  }
  protected others() {
    return this.tasks().filter((task) => task.id !== this.editing());
  }
  protected schedule(document: WorkspaceDocument) {
    const form = taskForm(document);
    if (!form.every) return { key: 'db.task.byHand', minutes: 0 };
    return form.every >= 60
      ? { key: 'db.task.everyHours', minutes: form.every / 60 }
      : { key: 'db.task.everyMinutes', minutes: form.every };
  }

  protected create() {
    this.start.set(emptyTaskForm());
    this.editing.set('new');
  }
  protected edit(document: WorkspaceDocument) {
    this.start.set(taskForm(document));
    this.editing.set(document.id);
  }
  protected duplicate(document: WorkspaceDocument) {
    this.start.set({ ...taskForm(document), name: `${document.name} 2` });
    this.editing.set('new');
  }
  protected save(form: TaskForm) {
    const editing = this.editing();
    if (!editing) return;
    void this.task.announce('The task could not be saved', async () => {
      const id = editing === 'new' ? this.section.state.cases.files.id() : editing;
      const existing = this.tasks().find((task) => task.id === editing);
      const saved = await (
        await this.section.cases()
      ).tasks.save(this.section.state.workspaceId(), id, form.name, taskValue(form), existing);
      this.section.state.applySaved([saved]);
      this.editing.set(undefined);
      await this.refresh();
      return success('Task saved', 'db.task.saved', { v0: saved.name });
    });
  }
  protected remove(document: WorkspaceDocument) {
    if (!this.section.state.confirm('Delete this task and its history?')) return;
    void this.task.announce('The task could not be deleted', async () => {
      await (await this.section.cases()).tasks.remove(document);
      this.section.state.forget(document);
      return success('Task deleted', 'db.task.deleted', { v0: document.name });
    });
  }
  protected run(document: WorkspaceDocument) {
    void this.task.announce('The task could not run', async () => {
      const run = await (
        await this.section.cases()
      ).tasks.run(this.section.state.workspaceId(), document.id);
      await this.refresh();
      this.shown.set(document.id);
      return success('Task run', `db.task.run.${run.state}`, {
        v0: document.name,
        v1: String(run.statements),
      });
    });
  }
}

function folderOf(document: WorkspaceDocument) {
  const folder = (document.value as { folder?: unknown } | undefined)?.folder;
  return typeof folder === 'string' ? folder : '';
}
