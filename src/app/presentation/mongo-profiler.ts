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
import { WorkspaceState, success } from './workspace-state';
import { DialogRequest, MongoDialog } from './mongo-dialog';
import { MONGO } from '../composition/providers';
import { WorkspaceDocument } from '../domain/models';
import {
  Explainable,
  PROFILE_LEVELS,
  ProfileEntry,
  ProfileStatus,
  explainable,
} from '../domain/mongo-indexes';

/** What each level records, as message keys. */
const LEVEL_NAMES = ['Off', 'Slow operations', 'Every operation'];

/**
 * The profiler of a database: its level and threshold, changed on the server after saying
 * what that does, and the slowest operations it recorded, each find or aggregation with its
 * explain one click away. A read-only connection only reads them.
 */
@Component({
  imports: [TranslocoPipe, MongoDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-profiler',
  styleUrl: './mongo-profiler.scss',
  templateUrl: './mongo-profiler.html',
})
export class MongoProfiler {
  readonly connection = input.required<WorkspaceDocument>();
  readonly database = input.required<string>();
  /** The collection shown in the explorer, to list only its operations. */
  readonly collection = input('');
  readonly writable = input(false);
  /** An operation to explain again. */
  readonly explain = output<Explainable>();
  protected readonly state = inject(WorkspaceState);
  private readonly mongo = inject(MONGO);

  protected readonly levels = PROFILE_LEVELS;
  protected readonly levelNames = LEVEL_NAMES;
  protected readonly status = signal<ProfileStatus | undefined>(undefined);
  protected readonly entries = signal<ProfileEntry[]>([]);
  protected readonly rows = computed(() =>
    this.entries().map((entry) => ({ entry, explainable: explainable(entry) })),
  );
  protected readonly onlyCollection = signal(false);
  protected readonly level = signal('0');
  protected readonly slowms = signal('100');
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly dialog = signal<DialogRequest | undefined>(undefined);
  protected readonly dialogProblem = signal<{ key: string } | undefined>(undefined);

  constructor() {
    effect(() => {
      this.database();
      this.connection();
      this.onlyCollection();
      if (this.onlyCollection()) this.collection();
      untracked(() => void this.load());
    });
  }

  private scope() {
    return [this.state.workspaceId(), this.connection(), this.state.scopes()] as const;
  }

  protected async load() {
    const database = this.database();
    this.loading.set(true);
    this.error.set('');
    try {
      const cases = await this.mongo();
      const status = await cases.tuning.profile(...this.scope(), database);
      const entries = await cases.tuning.profileEntries(
        ...this.scope(),
        database,
        this.onlyCollection() ? this.collection() : undefined,
      );
      if (this.database() !== database) return;
      this.status.set(status);
      this.level.set(String(status.level));
      this.slowms.set(String(status.slowms));
      this.entries.set(entries);
    } catch (error) {
      this.error.set(this.state.describe(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected setLevel(event: Event) {
    this.level.set((event.target as HTMLSelectElement).value);
  }
  protected setSlowms(event: Event) {
    this.slowms.set((event.target as HTMLInputElement).value);
  }
  protected setOnlyCollection(event: Event) {
    this.onlyCollection.set((event.target as HTMLInputElement).checked);
  }

  /** The threshold typed, or why it cannot be used. */
  protected readonly slowmsProblem = computed(() =>
    /^\d+$/.test(this.slowms().trim()) ? '' : 'mongo.notCount',
  );

  /** Asks before changing the profiler: it records every client's operations on the server. */
  protected change() {
    if (this.slowmsProblem()) return;
    const level = Number(this.level()) as 0 | 1 | 2;
    this.dialogProblem.set(undefined);
    this.dialog.set({
      title: 'Change the profiler',
      message: {
        key:
          level === 0
            ? 'mongo.profilerOff'
            : level === 1
              ? 'mongo.profilerSlow'
              : 'mongo.profilerAll',
        params: { v0: this.database(), v1: Number(this.slowms()) },
      },
      confirm: 'Change the profiler',
      danger: level === 2,
    });
  }

  protected cancel() {
    this.dialog.set(undefined);
  }

  /** Changes the profiler; on failure the dialog stays open with the reason. */
  protected async answer() {
    if (this.busy()) return;
    this.busy.set(true);
    this.dialogProblem.set(undefined);
    try {
      const level = Number(this.level()) as 0 | 1 | 2;
      const cases = await this.mongo();
      const status = await cases.tuning.setProfile(
        ...this.scope(),
        this.database(),
        level,
        Number(this.slowms()),
      );
      this.status.set(status);
      this.dialog.set(undefined);
      this.state.tell(
        success('Profiler changed', 'mongo.profilerLevel', {
          v0: this.database(),
          v1: String(status.level),
          v2: String(status.slowms),
        }),
      );
      await this.load();
    } catch (error) {
      this.dialogProblem.set({ key: this.state.describe(error) });
    } finally {
      this.busy.set(false);
    }
  }

  protected when(iso: string | undefined) {
    return iso ? new Date(iso).toLocaleString() : '';
  }
}
