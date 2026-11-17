import { computed, signal } from '@angular/core';
import {
  DashboardLayout,
  MIN_INTERVAL,
  Panel,
  PanelData,
  addReading,
  orderedPanels,
} from '../../domain/db/dashboard';
import type { DbSection } from './section';

/** The session of a connection's dashboard: its own, never an editor's. */
export const dashboardSession = (connection: string) => `dashboard:${connection}`;
/** How often the dashboard looks for panels due, in milliseconds. */
const TICK = 500;

/**
 * The dashboard of a connection open in a tab (DB-22): its session, the panels its driver
 * offers and the person's own, and what each has read, kept in memory only. Each panel is
 * read at its interval, never twice at once (a reading still running skips its turn), and
 * none while the dashboard is paused, its tab is not the one shown or the window is hidden.
 */
export class DashboardRun {
  readonly session: string;
  readonly predefined = signal<Panel[]>([]);
  readonly data = signal<Readonly<Record<string, PanelData>>>({});
  readonly errors = signal<Readonly<Record<string, string>>>({});
  readonly paused = signal(false);
  readonly status = signal<'closed' | 'opening' | 'open' | 'error'>('closed');
  readonly error = signal('');
  readonly panels = computed(() =>
    orderedPanels([...this.predefined(), ...this.layout().custom], this.layout()),
  );
  readonly shown = computed(() =>
    this.panels().filter((panel) => !this.layout().hidden.includes(panel.id)),
  );
  private timer?: ReturnType<typeof setInterval>;
  private readonly reading = new Set<string>();
  private readonly due = new Map<string, number>();

  constructor(
    private readonly section: DbSection,
    readonly connection: string,
    readonly layout: () => DashboardLayout,
    private readonly visible: () => boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.session = dashboardSession(connection);
  }

  /** Opens the dashboard's session, asks for the driver's panels and starts reading. */
  async start() {
    if (this.status() !== 'closed') return;
    this.status.set('opening');
    try {
      const connection = this.section.connection(this.connection);
      if (!connection) throw new Error('The connection is no longer there');
      if (!(await this.section.ensure(this.section.driverOf(this.connection))))
        throw new Error('db.dashboard.module');
      const cases = await this.section.cases();
      await cases.statements.open(
        this.workspace(),
        connection,
        this.session,
        this.section.state.scopes(),
        { manual: false },
      );
      // Closed while it was opening: its session goes too.
      if (this.status() !== 'opening') return void this.close();
      await this.section.drivers.learn(this.connection).catch(() => undefined);
      const methods = this.section.drivers.capabilities(this.connection)?.methods ?? [];
      if (methods.includes('dashboards'))
        this.predefined.set(await cases.dashboards.panels(this.workspace(), this.session));
      this.status.set('open');
      this.timer = setInterval(() => this.tick(), TICK);
      this.tick();
    } catch (error) {
      this.status.set('error');
      this.error.set(this.section.state.describe(error));
    }
  }

  /** Reads every panel shown that is due, unless paused, hidden, or still reading it. */
  tick() {
    if (this.status() !== 'open' || this.paused() || !this.visible()) return;
    const now = this.now();
    for (const panel of this.shown()) {
      if (this.reading.has(panel.id) || (this.due.get(panel.id) ?? 0) > now) continue;
      const every = Math.max(MIN_INTERVAL, this.layout().interval || panel.interval);
      this.due.set(panel.id, now + every * 1000);
      void this.read(panel);
    }
  }

  /** The intervals changed: every panel is due again. */
  restart() {
    this.due.clear();
    this.tick();
  }

  /** A panel's query changed: what it read before is forgotten. */
  forget(id: string) {
    this.due.delete(id);
    this.data.update(({ [id]: _gone, ...rest }) => rest);
    this.errors.update(({ [id]: _gone, ...rest }) => rest);
  }

  private async read(panel: Panel) {
    this.reading.add(panel.id);
    try {
      const cases = await this.section.cases();
      const values = await cases.dashboards.read(this.workspace(), this.session, panel.sql);
      if (this.status() !== 'open') return;
      const at = this.now();
      this.data.update((all) => ({
        ...all,
        [panel.id]: addReading(all[panel.id] ?? { series: [] }, values, at, panel.delta),
      }));
      this.errors.update(({ [panel.id]: _gone, ...rest }) => rest);
    } catch (error) {
      this.errors.update((all) => ({ ...all, [panel.id]: this.section.state.describe(error) }));
    } finally {
      this.reading.delete(panel.id);
    }
  }

  /** Stops reading and closes the dashboard's session. */
  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    const was = this.status();
    this.status.set('closed');
    if (was === 'open') await this.close();
  }

  private async close() {
    const cases = await this.section.cases();
    await cases.statements.close(this.workspace(), this.session).catch(() => undefined);
  }

  private workspace() {
    return this.section.state.workspaceId();
  }
}
