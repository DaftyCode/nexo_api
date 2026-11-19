import { WorkspaceDocument } from '../../domain/models';
import {
  Monitor,
  MonitorEvent,
  MonitorForm,
  MonitorRun,
  MonitorStatus,
  failuresToNotify,
  monitorValue,
  readMonitor,
  readMonitorHistory,
} from '../../domain/monitors';
import { ApiFailure, ApiPort, NotificationPort, noNotifications } from '../ports';

/**
 * Monitors: collections run on a schedule while Nexo is open. The backend runs them and
 * keeps their history; here they are saved, paused, run now and their failures notified.
 */
export class MonitorCases {
  constructor(
    private readonly api: ApiPort,
    private readonly notifications: NotificationPort = noNotifications,
  ) {}

  /** The monitors among a workspace's documents, by name. */
  monitors(documents: readonly WorkspaceDocument[]): Monitor[] {
    return documents
      .map(readMonitor)
      .filter((monitor): monitor is Monitor => !!monitor)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Saves a monitor with its revision; a new one starts running on its schedule. */
  save(
    workspace: string,
    id: string,
    form: MonitorForm,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    const paused = !!existing && !!readMonitor(existing)?.paused;
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'monitor',
      name: form.name.trim() || 'Monitor',
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: monitorValue(form, paused),
    });
  }

  /** Pauses a monitor, or lets it run on its schedule again. */
  setPaused(document: WorkspaceDocument, paused: boolean) {
    return this.api.save({
      ...document,
      value: { ...(document.value as Record<string, unknown>), paused },
    });
  }

  /** Deletes a monitor; the backend deletes its history with it. */
  remove(document: WorkspaceDocument) {
    return this.api.remove(document);
  }

  /** The last runs of a monitor, newest first; none before its first run. */
  async history(monitor: string): Promise<MonitorRun[]> {
    try {
      return readMonitorHistory((await this.api.document(`${monitor}~history`)).value);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return [];
      throw error;
    }
  }

  /** What the monitors of a workspace are doing, and the runs finished after `after`. */
  status(workspace: string, after = 0) {
    return this.api.execute<MonitorStatus>('monitor.status', { workspace, after });
  }

  /** Runs a monitor now, unless it is still running. */
  run(workspace: string, id: string) {
    return this.api.execute<{ state: string }>('monitor.run', { workspace, id });
  }

  /** Whether failures can be notified, and asking for it after a click. */
  notificationPermission() {
    return this.notifications.permission();
  }
  allowNotifications() {
    return this.notifications.request();
  }

  /** Shows a notification for each failure of a monitor that asks for it. */
  notify(
    events: readonly MonitorEvent[],
    text: (event: MonitorEvent) => { title: string; body: string },
  ) {
    for (const event of failuresToNotify(events)) {
      const { title, body } = text(event);
      this.notifications.show(title, body);
    }
  }
}
