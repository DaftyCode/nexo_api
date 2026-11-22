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
import { KillMode, ServerSession, SessionList, duration, shownSessions } from '../domain/db/admin';
import { DataGrid } from './data-grid/data-grid';
import { DbKillDialog } from './db-admin/kill-dialog';
import { AutoRefresh, REFRESH_EVERY } from './db-admin/refresh';
import { killModes } from './db-panel/admin';
import { navigatorSession } from './db-panel/navigator-session';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { PanelTask } from './panel-task';
import { StudioIcon } from './studio-icon';
import { success } from './workspace-state';

const column = (name: string) => ({ name, typeName: '', kind: 'text' });

/**
 * The sessions of a connection's server, as DBeaver's session manager: who is connected,
 * to which database, from where, doing what and for how long, filtered and without the idle
 * ones if asked, read again by hand or every few seconds. The statement of the session
 * chosen is shown whole below; it can be cancelled, or the session ended, after a question.
 * Nexo's own session is marked and never ended.
 */
@Component({
  imports: [TranslocoPipe, DataGrid, DbKillDialog, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-sessions',
  templateUrl: './db-sessions.html',
  styleUrl: './db-admin.scss',
})
export class DbSessions {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly list = signal<SessionList | undefined>(undefined);
  protected readonly text = signal('');
  protected readonly idle = signal(true);
  protected readonly chosen = signal<string | undefined>(undefined);
  protected readonly asking = signal<KillMode | undefined>(undefined);
  protected readonly refresh = new AutoRefresh(() => this.load(), inject(DestroyRef));
  protected readonly every = REFRESH_EVERY;
  protected readonly columns = [
    'Nexo',
    'ID',
    'User',
    'Database',
    'Application',
    'Client',
    'State',
    'Time',
    'Wait',
    'Statement',
  ].map(column);
  protected readonly shown = computed(() =>
    shownSessions(this.list()?.sessions ?? [], { text: this.text(), idle: this.idle() }),
  );
  protected readonly rows = computed(() =>
    this.shown().map((session) => [
      session.own ? 'This session' : '',
      session.id,
      session.user ?? null,
      session.database ?? null,
      session.application ?? null,
      session.client ?? null,
      session.state ?? null,
      duration(session.seconds),
      session.wait ?? null,
      session.sql ?? null,
    ]),
  );
  protected readonly current = computed(() =>
    this.shown().find((session) => session.id === this.chosen()),
  );
  protected readonly modes = computed(() => killModes(this.section, this.tab().connection));
  /** Why the session chosen cannot be cancelled nor ended, if it cannot. */
  protected readonly blocked = computed(() => {
    const session = this.current();
    if (!this.modes().length) return 'db.admin.readOnly';
    if (session?.own) return 'db.admin.own';
    return session ? '' : 'db.admin.choose';
  });
  protected readonly production = computed(
    () => this.section.typeOf(this.tab().connection).rules.confirmWrites,
  );

  constructor() {
    effect(() => {
      const connection = this.tab().connection;
      untracked(() => void this.load(connection));
    });
  }

  protected load(connection = this.tab().connection) {
    return this.task.run(async () => {
      const { cases, workspace, session } = await navigatorSession(this.section, connection);
      this.list.set(await cases.admin.sessions(workspace, session));
    });
  }

  protected choose(row: number) {
    this.chosen.set(this.shown()[row]?.id);
  }
  protected filter(event: Event) {
    this.text.set((event.target as HTMLInputElement).value);
  }
  protected showIdle(event: Event) {
    this.idle.set((event.target as HTMLInputElement).checked);
  }
  protected setEvery(event: Event) {
    this.refresh.set(Number((event.target as HTMLSelectElement).value));
  }

  /** Cancels the statement of the session chosen or ends it, once confirmed. */
  protected kill(session: ServerSession, mode: KillMode, typed: string) {
    this.asking.set(undefined);
    void this.task.run(async () => {
      const {
        cases,
        workspace,
        session: asking,
      } = await navigatorSession(this.section, this.tab().connection);
      const done = await cases.admin.kill(workspace, asking, session.id, mode, typed);
      const said = !done
        ? 'The session was no longer there'
        : mode === 'cancel'
          ? 'Query cancelled'
          : 'Session ended';
      this.section.state.tell(success(said));
      this.list.set(await cases.admin.sessions(workspace, asking));
    });
  }
}
