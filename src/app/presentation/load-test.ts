import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  WritableSignal,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormField, form, max, min } from '@angular/forms/signals';
import { PerformanceStatus } from '../application/integration-use-cases';
import { INTEGRATION } from '../composition/providers';
import { toPortableRows } from '../domain/variables';
import { PanelTask } from './panel-task';
import { WorkspaceState } from './workspace-state';

/**
 * A load test of the active request: virtual users, duration, load profile and results. It
 * belongs to the panel, so a test keeps running and showing its results across its tabs.
 */
export class LoadTestRun {
  private readonly state = inject(WorkspaceState);
  private readonly integration = inject(INTEGRATION);
  readonly model = signal({ users: 1, duration: 10, profile: 'fixed' });
  readonly fields = form(this.model, (p) => {
    min(p.users, 1);
    max(p.users, 4);
    min(p.duration, 1);
    max(p.duration, 120);
  });
  readonly status = signal<PerformanceStatus | undefined>(undefined);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private id = '';

  constructor(
    private readonly task: PanelTask,
    private readonly output: WritableSignal<string>,
  ) {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  start() {
    void this.task.run(async () => {
      const request = this.state.active()?.request;
      if (!request) throw new Error('Open a request first');
      const m = this.model();
      const result = await this.integration.startLoadTest(this.state.workspaceId(), {
        users: m.users,
        duration: m.duration,
        profile: m.profile,
        request,
        variables: this.state.variables(),
        globals: toPortableRows(this.state.globalRows()),
        ancestors: this.state.activeAncestors(),
      });
      this.id = result.id;
      this.status.set({ state: 'running' });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.poll(), 500);
    });
  }
  private async poll() {
    try {
      const result = await this.integration.loadTestStatus(this.state.workspaceId(), this.id);
      this.status.set(result);
      this.output.set(JSON.stringify(result.summary ?? result, null, 2));
      if (result.state === 'running') this.timer = setTimeout(() => void this.poll(), 500);
    } catch (error) {
      this.output.set(error instanceof Error ? error.message : String(error));
    }
  }
  stop() {
    void this.task.run(async () => {
      if (!this.id) return;
      await this.integration.cancelLoadTest(this.state.workspaceId(), this.id);
    });
  }
}

/** The load test tab of the integration panel. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-load-test',
  styleUrl: './integration-panel.scss',
  templateUrl: './load-test.html',
})
export class LoadTest {
  readonly run = input.required<LoadTestRun>();
}
