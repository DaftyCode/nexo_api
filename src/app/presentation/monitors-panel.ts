import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  Monitor,
  MonitorForm as MonitorFormModel,
  MonitorRun,
  emptyMonitorForm,
  monitorForm,
  scheduleText,
} from '../domain/monitors';
import { MonitorForm } from './monitor-form';
import { MonitorHistory } from './monitor-history';
import { MonitorsStore } from './monitors-store';
import { PanelTask } from './panel-task';
import { WorkspaceState, success } from './workspace-state';

/**
 * Monitors: collections run on a schedule while Nexo is open, with their last runs. Each
 * one runs now, pauses or is deleted here; a failure is notified when the monitor asks.
 */
@Component({
  imports: [TranslocoPipe, DatePipe, MonitorForm, MonitorHistory],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-monitors-panel',
  styleUrl: './monitors-panel.scss',
  templateUrl: './monitors-panel.html',
})
export class MonitorsPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly store = inject(MonitorsStore);
  protected readonly task = new PanelTask(this.state);
  protected readonly selectedId = signal('');
  protected readonly selected = computed(() =>
    this.store.monitors().find((monitor) => monitor.id === this.selectedId()),
  );
  /** The form open: `new`, the id of the monitor edited, or none. */
  protected readonly editing = signal('');
  protected readonly initial = signal<MonitorFormModel>(emptyMonitorForm());
  protected readonly history = signal<readonly MonitorRun[]>([]);
  protected readonly permission = signal(this.state.cases.monitors.notificationPermission());
  protected readonly schedule = scheduleText;

  constructor() {
    void this.store.refresh().catch(() => undefined);
    // The history of the monitor shown, again whenever one of its runs finishes.
    effect(() => {
      const id = this.selectedId();
      const finished = this.store.finished().some((event) => event.monitor === id);
      if (id && (finished || untracked(() => this.history().length === 0)))
        untracked(() => void this.loadHistory(id));
    });
  }

  protected select(monitor: Monitor) {
    this.editing.set('');
    this.history.set([]);
    this.selectedId.set(monitor.id);
  }
  protected create() {
    this.initial.set({
      ...emptyMonitorForm(this.state.collections()[0]?.id ?? ''),
      environment: this.state.environmentId(),
    });
    this.editing.set('new');
  }
  protected edit(monitor: Monitor) {
    this.initial.set(monitorForm(monitor));
    this.editing.set(monitor.id);
  }
  protected save(form: MonitorFormModel) {
    const editing = this.editing();
    void this.task.announce('The monitor could not be saved', async () => {
      const id = editing === 'new' ? crypto.randomUUID() : editing;
      const existing = this.state.documents().find((document) => document.id === id);
      const saved = await this.state.cases.monitors.save(
        this.state.workspaceId(),
        id,
        form,
        existing,
      );
      this.state.applySaved([saved]);
      this.editing.set('');
      this.selectedId.set(saved.id);
      await this.store.refresh();
      return success('Monitor saved', 'toast.monitorSaved', { v0: saved.name });
    });
  }
  protected runNow(monitor: Monitor) {
    void this.task.run(async () => {
      await this.state.cases.monitors.run(this.state.workspaceId(), monitor.id);
      await this.store.refresh();
    });
  }
  protected setPaused(monitor: Monitor, paused: boolean) {
    const document = this.state.documents().find((d) => d.id === monitor.id);
    if (!document) return;
    void this.task.run(async () => {
      this.state.applySaved([await this.state.cases.monitors.setPaused(document, paused)]);
      await this.store.refresh();
    });
  }
  protected remove(monitor: Monitor) {
    const document = this.state.documents().find((d) => d.id === monitor.id);
    if (!document || !this.state.confirm('Delete this monitor and its history?')) return;
    void this.task.announce('The monitor could not be deleted', async () => {
      await this.state.cases.monitors.remove(document);
      this.state.forget(document);
      this.selectedId.set('');
      return success('Monitor deleted', 'toast.monitorDeleted', { v0: monitor.name });
    });
  }
  protected allowNotifications() {
    void this.task.run(async () =>
      this.permission.set(await this.state.cases.monitors.allowNotifications()),
    );
  }
  /** The name of a collection, or that it no longer exists. */
  protected collectionName(id: string) {
    return this.state.collections().find((d) => d.id === id)?.name;
  }
  protected environmentName(id: string) {
    return this.state.environments().find((d) => d.id === id)?.name;
  }
  private async loadHistory(id: string) {
    try {
      const runs = await this.state.cases.monitors.history(id);
      if (this.selectedId() === id) this.history.set(runs);
    } catch (error) {
      this.task.error.set(this.state.describe(error));
    }
  }
}
