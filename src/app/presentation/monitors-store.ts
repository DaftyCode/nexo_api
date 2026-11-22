import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { MonitorEvent, MonitorStatus } from '../domain/monitors';
import { WorkspaceState } from './workspace-state';

/** How often the monitors are asked about: while one runs, while idle and while hidden. */
const POLL = { running: 2_000, idle: 15_000, hidden: 60_000 };

/**
 * What the monitors of the open workspace are doing, asked of the backend while it has
 * monitors, and a system notification for each run that fails (of any workspace) when its
 * monitor asks for one. The runs that finished before the workspace was opened are not
 * notified.
 */
@Injectable({ providedIn: 'root' })
export class MonitorsStore {
  private readonly state = inject(WorkspaceState);
  private readonly i18n = inject(TranslocoService);
  readonly monitors = computed(() => this.state.cases.monitors.monitors(this.state.documents()));
  readonly status = signal<MonitorStatus | undefined>(undefined);
  /** The runs that finished since the previous answer, to reload the history shown. */
  readonly finished = signal<readonly MonitorEvent[]>([]);
  private sequence: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private workspace = '';

  /** Asked about only while the workspace has monitors or scheduled database tasks. */
  private readonly watched = computed(
    () =>
      this.monitors().length > 0 ||
      this.state.documents().some((document) => document.kind === 'db-task'),
  );

  constructor() {
    effect(() => {
      const workspace = this.state.workspaceId();
      const watched = this.watched();
      untracked(() => this.watch(workspace, watched));
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** The state of monitor `id` now. */
  live(id: string) {
    return this.status()?.monitors.find((monitor) => monitor.id === id);
  }

  /**
   * Asks again at once, after a change made here, and asks next as often as the answer
   * needs: soon while a monitor runs, so its run shows as soon as it ends.
   */
  async refresh() {
    const workspace = this.workspace;
    if (!workspace) return;
    try {
      await this.ask(workspace);
    } finally {
      if (workspace === this.workspace) this.schedule();
    }
  }

  private async ask(workspace: string) {
    const status = await this.state.cases.monitors.status(workspace, this.sequence ?? 0);
    if (this.sequence !== undefined) {
      this.finished.set(status.finished);
      this.state.cases.monitors.notify(status.finished, (event) => this.text(event));
    }
    this.sequence = status.sequence;
    this.status.set(status);
  }

  private text(event: MonitorEvent): { title: string; body: string } {
    if (event.kind === 'db-task') {
      const differences = event.state === 'differences';
      return {
        title: this.i18n.translate<string>(
          differences ? 'db.task.differencesTitle' : 'db.task.failedTitle',
          { v0: event.name },
        ),
        body: differences
          ? this.i18n.translate<string>('db.task.differences', {
              v0: String(event.differences ?? 0),
            })
          : (event.error ?? ''),
      };
    }
    const title = this.i18n.translate<string>('monitor.failedTitle', { v0: event.name });
    const body =
      event.error ??
      this.i18n.translate<string>('monitor.failedBody', {
        v0: String(event.failedAssertions ?? 0),
        v1: String(event.failedRequests ?? 0),
      });
    return { title, body };
  }

  private watch(workspace: string, watched: boolean) {
    if (workspace !== this.workspace) this.status.set(undefined);
    this.stop();
    this.workspace = watched ? workspace : '';
    if (watched) void this.poll();
  }
  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private async poll() {
    try {
      await this.refresh();
    } catch {
      // The next poll tries again; the panel shows its own errors.
    }
  }
  private schedule() {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const running = this.status()?.monitors.some((monitor) => monitor.running);
    const delay = hidden ? POLL.hidden : running ? POLL.running : POLL.idle;
    this.stop();
    this.timer = setTimeout(() => void this.poll(), delay);
  }
}
