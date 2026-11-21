import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { NATIVE_FILES } from '../composition/providers';
import { connectionVariables } from '../application/database-use-cases/connections';
import type { LocatedTool } from '../application/database-use-cases/native';
import { readDbConnection } from '../domain/db/connection';
import {
  BACKUP_CONTENTS,
  BACKUP_FORMATS,
  NativeAction,
  NativeRun,
  backupFileName,
  emptyNativeForm,
  formatOfFile,
  olderThanServer,
} from '../domain/db/native';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { PanelTask } from './panel-task';
import { success } from './workspace-state';

/** How often a run is read while it goes. */
const EVERY = 1000;

/**
 * «Backup and restore» of a connection (DB-23, desktop app): a backup, a restore or a `.sql`
 * script run with the engine's own client tools, found in the connection's Local client
 * folder or where they are usually installed. A restore asks for the database typed and,
 * on production, a second confirmation; the run is followed line by line and can be
 * cancelled.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-native',
  templateUrl: './db-native.html',
  styleUrl: './db-admin.scss',
})
export class DbNative {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly files = inject(NATIVE_FILES);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly formats = BACKUP_FORMATS;
  protected readonly contents = BACKUP_CONTENTS;
  protected readonly levels = ['', '0', '1', '3', '6', '9'];
  protected readonly action = signal<NativeAction>('backup');
  protected readonly model = signal(emptyNativeForm());
  protected readonly fields = form(this.model);
  protected readonly located = signal<LocatedTool | undefined>(undefined);
  protected readonly run = signal<NativeRun | undefined>(undefined);
  private runId = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly document = computed(() => this.section.connection(this.tab().connection));
  protected readonly value = computed(() => readDbConnection(this.document()?.value));
  protected readonly postgres = computed(() => this.value().driver === 'postgres');
  protected readonly production = computed(() => this.value().type === 'production');
  /** The database a restore or a script goes to. */
  protected readonly database = computed(
    () => this.model().database.trim() || this.value().database || '',
  );
  protected readonly running = computed(() => this.run()?.state === 'running');
  /** A restore starts once the database it goes to is typed. */
  protected readonly ready = computed(
    () =>
      !this.running() &&
      (this.action() !== 'restore' ||
        (!!this.database() && this.model().confirmName.trim() === this.database())),
  );
  /** The tools found are older than the server, which they may not read. */
  protected readonly older = computed(() => {
    const server = this.section.tree.servers()[this.tab().connection]?.serverVersion;
    const found = this.located();
    return !!found && olderThanServer(found.version, server);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  /** What the tool of the chosen action is asked for. */
  private need() {
    const action = this.action();
    if (action === 'script') return 'script' as const;
    if (action === 'restore')
      return this.postgres() && this.model().format !== 'plain' ? 'archive' : 'plain';
    return this.postgres() && this.model().server ? 'server' : 'backup';
  }

  protected choose(action: NativeAction) {
    this.action.set(action);
    this.located.set(undefined);
  }

  /** Finds the tool the chosen action would use, and its version. */
  protected detect() {
    void this.task.run(async () => {
      const cases = await this.section.cases();
      this.located.set(
        await cases.native.locate(
          this.section.state.workspaceId(),
          this.tab().connection,
          this.need(),
        ),
      );
    });
  }

  /** Chooses the file and starts the run, after what a restore or a script asks first. */
  protected start() {
    void this.section.state.announce('The local client could not start', async () => {
      const action = this.action();
      const form = this.model();
      const directory = action === 'backup' && this.postgres() && form.format === 'directory';
      const path = await this.files.choose(
        action === 'backup' ? (directory ? 'folder' : 'save') : 'open',
        backupFileName(this.value().database ?? '', form.format),
      );
      if (!path) return undefined;
      if (action === 'restore' && this.postgres())
        this.model.update((m) => ({
          ...m,
          format: m.format === 'directory' ? m.format : formatOfFile(path),
        }));
      const name = this.document()?.name ?? '';
      const typed = action === 'restore' ? form.confirmName.trim() : undefined;
      const confirm =
        action !== 'backup' &&
        this.production() &&
        this.section.state.confirm('db.native.confirmProduction', { v0: name });
      if (action !== 'backup' && this.production() && !confirm) return undefined;
      const cases = await this.section.cases();
      const started = await cases.native.start({
        workspace: this.section.state.workspaceId(),
        connection: this.tab().connection,
        driver: this.value().driver,
        action,
        form: this.model(),
        path,
        variables: connectionVariables(this.document()?.value, this.section.state.scopes()),
        confirmName: typed,
        confirm,
      });
      this.located.set({ tool: started.tool, path: '', version: started.version });
      this.runId = started.id;
      this.run.set({ tool: started.tool, state: 'running', lines: [], dropped: 0, seconds: 0 });
      this.follow();
      return success('The local client is running', 'db.native.started', { v0: started.tool });
    });
  }

  /** Reads the run again until it ends. */
  private follow() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        const cases = await this.section.cases();
        const run = await cases.native.status(this.runId);
        this.run.set(run);
        if (run.state === 'running') this.follow();
      } catch (error) {
        this.section.state.error.set(this.section.state.describe(error));
      }
    }, EVERY);
  }

  protected cancel() {
    void this.task.run(async () => {
      const cases = await this.section.cases();
      await cases.native.cancel(this.runId);
    });
  }

  protected stateLabel(state: string) {
    return `db.native.state.${state}`;
  }
  protected formatLabel(format: string) {
    return `db.native.format.${format}`;
  }
  protected contentLabel(content: string) {
    return `db.native.content.${content}`;
  }
}
