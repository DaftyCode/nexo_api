import { TranslocoPipe } from '@jsverse/transloco';
import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { FormField, form, min, max } from '@angular/forms/signals';

import { WorkspaceState } from './workspace-state';
import { DATA } from '../composition/providers';
import { RunnerStore } from './runner-store';

@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-runner-panel',
  styleUrl: './runner-panel.scss',
  templateUrl: './runner-panel.html',
})
export class RunnerPanel {
  protected readonly state = inject(WorkspaceState);
  private readonly data = inject(DATA);
  protected readonly runner = inject(RunnerStore);
  /** Starting, polling and cancelling runs report their errors in this panel. */
  protected readonly task = this.runner.task;
  protected readonly model = signal({ collection: '', iterations: 1, data: '[]' });
  protected readonly fields = form(this.model, (p) => {
    min(p.iterations, 1);
    max(p.iterations, 10000);
  });
  protected start() {
    void this.task.run(async () => {
      const m = this.model();
      let data: unknown;
      try {
        data = JSON.parse(m.data || '[]');
      } catch {
        throw new Error('Iteration data must be a JSON array');
      }
      if (!Array.isArray(data)) throw new Error('Iteration data must be a JSON array');
      await this.runner.start(m.collection || this.state.collections()[0]?.id, m.iterations, data);
    });
  }
  protected async file(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await this.task.run(async () => {
      const content = await file.text();
      // CSV and JSON files are parsed without storing a dataset.
      const rows = await this.data.parseRows(this.state.workspaceId(), content);
      this.model.update((m) => ({ ...m, data: JSON.stringify(rows, null, 2) }));
    });
  }
}
