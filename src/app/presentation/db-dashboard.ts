import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Panel } from '../domain/db/dashboard';
import { Chart } from './charts/chart';
import { DbPanelEditor } from './db-dashboard/panel-editor';
import { DbSection } from './db-panel/section';
import type { DbTab } from './db-panel/tabs-store';
import { StudioIcon } from './studio-icon';
import { ListDrag } from './workspace/list-drag';

/**
 * The dashboard of a connection's server (DB-22), as DBeaver's: a grid of charts, each a
 * panel read every few seconds on the dashboard's own session. The panels are put in another
 * order (by dragging or with their buttons), made wider, hidden or shown; the interval is
 * one for all or each panel's own; the readings can be paused. The person adds panels of
 * their own: a query that only reads. Where they are is kept per connection in the
 * workspace; what they read is kept in memory only.
 */
@Component({
  imports: [TranslocoPipe, Chart, DbPanelEditor, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-dashboard',
  templateUrl: './db-dashboard.html',
  styleUrl: './db-dashboard.scss',
})
export class DbDashboard {
  readonly tab = input.required<DbTab>();
  protected readonly section = inject(DbSection);
  protected readonly dashboards = this.section.dashboards;
  protected readonly run = computed(() => this.dashboards.run(this.tab()));
  protected readonly layout = computed(() => this.dashboards.layout(this.tab().connection));
  /** Seconds between readings for every panel; 0 keeps each panel's own. */
  protected readonly intervals = [0, 1, 2, 5, 10, 30, 60];
  /** The panel being written: a new one, or one of the person's. */
  protected readonly editing = signal<Panel | 'new' | undefined>(undefined);
  protected readonly drag = new ListDrag('auto', (id, over, side) =>
    this.dashboards.place(this.run(), id, over, side),
  );

  constructor() {
    // Started the first time it is shown; it reads only while its tab is the one shown.
    effect(() => {
      const run = this.run();
      untracked(() => void run.start());
    });
  }

  protected wide(id: string) {
    return this.layout().wide.includes(id);
  }
  protected shown(id: string) {
    return !this.layout().hidden.includes(id);
  }
  protected setInterval(event: Event) {
    this.dashboards.setInterval(this.run(), Number((event.target as HTMLSelectElement).value));
  }
  protected togglePause() {
    const run = this.run();
    run.paused.update((paused) => !paused);
    run.tick();
  }
  protected remove(panel: Panel) {
    if (!this.section.state.confirm('Delete this panel?')) return;
    this.dashboards.removeCustom(this.run(), panel.id);
  }
  protected saved(panel: Panel) {
    this.editing.set(undefined);
    this.dashboards.keepCustom(this.run(), panel);
  }
  protected edited(): Panel | undefined {
    const editing = this.editing();
    return editing === 'new' ? undefined : editing;
  }
}
