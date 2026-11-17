import { signal, untracked } from '@angular/core';
import { DashboardLayout, Panel, emptyLayout } from '../../domain/db/dashboard';
import { NavigatorRow } from '../../domain/db/rows';
import { DashboardRun } from './dashboard-run';
import type { DbSection } from './section';
import type { DbTab } from './tabs-store';

/**
 * The dashboards of the section (DB-22): how each connection's dashboard is laid out, kept
 * in the workspace session (the order and width of its panels, those hidden, its interval
 * and the person's own panels), and the dashboard of each tab while it is open. Closing the
 * tab stops its readings and closes its session.
 */
export class SectionDashboards {
  readonly layouts = signal<Readonly<Record<string, DashboardLayout>>>({});
  private readonly runs = new Map<string, DashboardRun>();

  constructor(private readonly section: DbSection) {
    const stored = untracked(() => section.state.databaseSession())?.dashboards;
    if (stored) this.layouts.set(stored);
  }

  /** Opens the dashboard of a connection, one tab per connection. */
  open(row: NavigatorRow) {
    if (!row.connection) return;
    this.section.tabs.open({ kind: 'dashboard', connection: row.connection, title: 'Dashboard' });
  }

  layout(connection: string): DashboardLayout {
    return this.layouts()[connection] ?? emptyLayout();
  }
  private change(connection: string, change: (layout: DashboardLayout) => DashboardLayout) {
    this.layouts.update((all) => ({ ...all, [connection]: change(this.layout(connection)) }));
  }

  /** The dashboard of a tab, kept while the tab is open; its view starts it. */
  run(tab: DbTab): DashboardRun {
    const kept = this.runs.get(tab.id);
    if (kept) return kept;
    const run = new DashboardRun(
      this.section,
      tab.connection,
      () => this.layout(tab.connection),
      () => this.section.tabs.activeId() === tab.id && !globalThis.document?.hidden,
    );
    this.runs.set(tab.id, run);
    return run;
  }
  close(tab: string) {
    const run = this.runs.get(tab);
    if (!run) return;
    this.runs.delete(tab);
    void run.stop();
  }
  closeAll() {
    for (const tab of [...this.runs.keys()]) this.close(tab);
  }

  /** Moves a panel one place earlier or later among those shown. */
  move(run: DashboardRun, id: string, by: -1 | 1) {
    const order = run.panels().map((panel) => panel.id);
    const shown = run.shown().map((panel) => panel.id);
    const neighbour = shown[shown.indexOf(id) + by];
    if (!neighbour) return;
    const [from, to] = [order.indexOf(id), order.indexOf(neighbour)];
    [order[from], order[to]] = [order[to], order[from]];
    this.change(run.connection, (layout) => ({ ...layout, order }));
  }
  /** Puts a panel where another one is, as dragging it there does. */
  place(run: DashboardRun, id: string, over: string, side: 'before' | 'after') {
    const order = run
      .panels()
      .map((panel) => panel.id)
      .filter((each) => each !== id);
    const at = order.indexOf(over);
    if (at < 0) return;
    order.splice(side === 'before' ? at : at + 1, 0, id);
    this.change(run.connection, (layout) => ({ ...layout, order }));
  }
  toggleWide(connection: string, id: string) {
    this.change(connection, (layout) => ({ ...layout, wide: toggled(layout.wide, id) }));
  }
  toggleShown(connection: string, id: string) {
    this.change(connection, (layout) => ({ ...layout, hidden: toggled(layout.hidden, id) }));
  }
  setInterval(run: DashboardRun, seconds: number) {
    this.change(run.connection, (layout) => ({ ...layout, interval: seconds }));
    run.restart();
  }

  /** Keeps a panel of the person's, new or changed. */
  keepCustom(run: DashboardRun, panel: Panel) {
    this.change(run.connection, (layout) => {
      const custom = layout.custom.filter((each) => each.id !== panel.id);
      return { ...layout, custom: [...custom, { ...panel, custom: true }] };
    });
    run.forget(panel.id);
  }
  removeCustom(run: DashboardRun, id: string) {
    this.change(run.connection, (layout) => ({
      ...layout,
      custom: layout.custom.filter((each) => each.id !== id),
      order: layout.order.filter((each) => each !== id),
      hidden: layout.hidden.filter((each) => each !== id),
      wide: layout.wide.filter((each) => each !== id),
    }));
    run.forget(id);
  }
}

const toggled = (list: readonly string[], id: string) =>
  list.includes(id) ? list.filter((each) => each !== id) : [...list, id];
