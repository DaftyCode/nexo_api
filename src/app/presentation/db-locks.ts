import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { LockList, WaitRow, duration, waitTree } from '../domain/db/admin';
import { DbKillDialog, KillTarget } from './db-admin/kill-dialog';
import { AutoRefresh, REFRESH_EVERY } from './db-admin/refresh';
import { killModes } from './db-panel/admin';
import { navigatorSession } from './db-panel/navigator-session';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { PanelTask } from './panel-task';
import { StudioIcon } from './studio-icon';
import { success } from './workspace-state';

/**
 * The locks of a connection's server, as DBeaver's lock manager: who waits for whom, as a
 * tree with the session that blocks on top and the ones that wait for it below, with what
 * each waits for, for how long, and the statements of both sides. The session that blocks
 * can be ended from here, after a question, under the same rules as in the sessions.
 */
@Component({
  imports: [TranslocoPipe, DbKillDialog, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-locks',
  templateUrl: './db-locks.html',
  styleUrl: './db-admin.scss',
})
export class DbLocks {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly list = signal<LockList | undefined>(undefined);
  protected readonly ending = signal<KillTarget | undefined>(undefined);
  protected readonly refresh = new AutoRefresh(() => this.load(), inject(DestroyRef));
  protected readonly every = REFRESH_EVERY;
  protected readonly rows = computed(() => waitTree(this.list()?.waits ?? []));
  /** The sessions of the server are ended here only where the driver can and may. */
  protected readonly ends = computed(() =>
    killModes(this.section, this.tab().connection).includes('terminate'),
  );
  protected readonly production = computed(
    () => this.section.typeOf(this.tab().connection) === 'production',
  );
  protected readonly duration = duration;

  constructor() {
    effect(() => {
      const connection = this.tab().connection;
      untracked(() => void this.load(connection));
    });
  }

  protected load(connection = this.tab().connection) {
    return this.task.run(async () => {
      const { cases, workspace, session } = await navigatorSession(this.section, connection);
      this.list.set(await cases.admin.locks(workspace, session));
    });
  }

  protected setEvery(event: Event) {
    this.refresh.set(Number((event.target as HTMLSelectElement).value));
  }

  protected ask(row: WaitRow) {
    this.ending.set({
      id: row.session,
      ...(row.user ? { user: row.user } : {}),
      ...(row.sql ? { sql: row.sql } : {}),
    });
  }

  /** Ends the session that blocks, once confirmed, and reads the waits again. */
  protected end(target: KillTarget, typed: string) {
    this.ending.set(undefined);
    void this.task.run(async () => {
      const { cases, workspace, session } = await navigatorSession(
        this.section,
        this.tab().connection,
      );
      const done = await cases.admin.kill(workspace, session, target.id, 'terminate', typed);
      this.section.state.tell(success(done ? 'Session ended' : 'The session was no longer there'));
      this.list.set(await cases.admin.locks(workspace, session));
    });
  }
}
