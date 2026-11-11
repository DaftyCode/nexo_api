import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState, named } from './workspace-state';
import { CodeEditor } from './code-editor';
import { DialogRequest, MongoDialog } from './mongo-dialog';
import { MONGO } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import { WriteTextError } from '../domain/mongo-write';
import {
  IndexDetail,
  IndexForm,
  defaultIndexName,
  emptyIndexForm,
  formatBytes,
  indexRequest,
  indexView,
} from '../domain/mongo-indexes';
import type { QueryTarget } from '../application/mongo-use-cases';

interface Problem {
  key: string;
  params?: Record<string, unknown>;
}

/**
 * The indexes of a collection: what each one is, its size and how often queries used it;
 * new ones created from a form; and indexes hidden from the query planner, shown again or
 * dropped, each after saying what it changes. A read-only connection only lists them.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor, MongoDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-indexes',
  styleUrl: './mongo-indexes.scss',
  templateUrl: './mongo-indexes.html',
})
export class MongoIndexes {
  readonly connection = input.required<WorkspaceDocument>();
  readonly target = input.required<QueryTarget>();
  readonly writable = input(false);
  /** The indexes changed: the collection's statistics are read again. */
  readonly changed = output<void>();
  protected readonly state = inject(WorkspaceState);
  private readonly mongo = inject(MONGO);

  protected readonly indexes = signal<IndexDetail[]>([]);
  protected readonly views = computed(() =>
    this.indexes().map((index) => ({ ...indexView(index), detail: index })),
  );
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly creating = signal(false);
  protected readonly model = signal<IndexForm>(emptyIndexForm());
  protected readonly fields = form(this.model);
  protected readonly problem = signal<Problem | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly dialog = signal<DialogRequest | undefined>(undefined);
  protected readonly dialogProblem = signal<Problem | undefined>(undefined);
  private pending: (() => Promise<string>) | undefined;
  protected readonly bytes = formatBytes;

  constructor() {
    effect(() => {
      this.target();
      this.connection();
      untracked(() => void this.load());
    });
  }

  private scope() {
    return [this.state.workspaceId(), this.connection(), this.state.scopes()] as const;
  }

  protected async load() {
    const target = this.target();
    this.loading.set(true);
    this.error.set('');
    try {
      const listed = await (await this.mongo()).indexes(...this.scope(), target);
      if (this.target() === target) this.indexes.set(listed);
    } catch (error) {
      this.indexes.set([]);
      this.error.set(this.state.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected since(iso: string | undefined) {
    return iso ? new Date(iso).toLocaleString() : '';
  }

  protected newIndex() {
    this.model.set(emptyIndexForm());
    this.problem.set(undefined);
    this.creating.set(true);
  }

  /** Creates the index of the form; on failure the form stays, with the reason. */
  protected async create() {
    if (this.busy()) return;
    this.problem.set(undefined);
    let request: ReturnType<typeof indexRequest>;
    try {
      request = indexRequest(this.model());
    } catch (error) {
      if (!(error instanceof WriteTextError)) throw error;
      this.problem.set({ key: error.key, params: error.params });
      return;
    }
    this.busy.set(true);
    try {
      const cases = await this.mongo();
      await cases.createIndex(...this.scope(), this.target(), request.keys, request.options);
      const name =
        typeof request.options['name'] === 'string'
          ? request.options['name']
          : defaultIndexName(request.keys);
      this.creating.set(false);
      this.state.tell(named('Index created', name));
      await this.load();
      this.changed.emit();
    } catch (error) {
      this.problem.set({ key: this.state.describe(error) });
    } finally {
      this.busy.set(false);
    }
  }

  protected hide(index: IndexDetail, hidden: boolean) {
    this.ask(
      {
        title: hidden ? 'Hide index' : 'Show index',
        message: {
          key: hidden ? 'mongo.hidingIndex' : 'mongo.showingIndex',
          params: { v0: index.name },
        },
        confirm: hidden ? 'Hide index' : 'Show index',
      },
      async () => {
        const cases = await this.mongo();
        await cases.hideIndex(...this.scope(), this.target(), index.name, hidden);
        return hidden ? 'Index hidden' : 'Index shown';
      },
      index.name,
    );
  }

  protected drop(index: IndexDetail) {
    this.ask(
      {
        title: 'Drop index',
        message: { key: 'mongo.droppingIndex', params: { v0: index.name } },
        confirmName: index.name,
        confirm: 'Drop index',
        danger: true,
      },
      async () => {
        const cases = await this.mongo();
        await cases.dropIndex(...this.scope(), this.target(), index.name, index.name);
        return 'Index dropped';
      },
      index.name,
    );
  }

  private ask(request: DialogRequest, action: () => Promise<string>, name: string) {
    this.dialogProblem.set(undefined);
    this.pending = async () => {
      const done = await action();
      this.state.tell(named(done, name));
      return done;
    };
    this.dialog.set(request);
  }

  protected cancel() {
    this.dialog.set(undefined);
    this.pending = undefined;
  }

  /** Runs what the dialog asked; on failure it stays open with the reason. */
  protected async answer() {
    const action = this.pending;
    if (!action || this.busy()) return;
    this.busy.set(true);
    this.dialogProblem.set(undefined);
    try {
      await action();
      this.cancel();
      await this.load();
      this.changed.emit();
    } catch (error) {
      this.dialogProblem.set({ key: this.state.describe(error) });
    } finally {
      this.busy.set(false);
    }
  }
}
