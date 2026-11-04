import { TranslocoPipe } from '@jsverse/transloco';
import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { FormField, form, min, max } from '@angular/forms/signals';

import { WorkspaceState } from './workspace-state';

@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-runner-panel',
  styleUrl: './runner-panel.scss',
  templateUrl: './runner-panel.html',
})
export class RunnerPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly model = signal({ collection: '', iterations: 1, data: '[]' });
  protected readonly fields = form(this.model, (p) => {
    min(p.iterations, 1);
    max(p.iterations, 10000);
  });
  protected start() {
    void this.state.guard(async () => {
      const m = this.model();
      let data: unknown = JSON.parse(m.data || '[]');
      if (!Array.isArray(data)) throw new Error('Iteration data must be a JSON array');
      await this.state.startRun(
        m.collection || this.state.collections()[0]?.id,
        m.iterations,
        data,
      );
    });
  }
  protected async file(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await this.state.guard(async () => {
      const content = await file.text();
      if (file.name.endsWith('.csv')) {
        const dataset = await this.state.cases.api.execute<{ id: string }>('dataset.import', {
          content,
        });
        const result = await this.state.cases.api.execute<{ rows: unknown[] }>('dataset.query', {
          id: dataset.id,
          sql: 'SELECT * FROM data',
        });
        this.model.update((m) => ({ ...m, data: JSON.stringify(result.rows, null, 2) }));
      } else this.model.update((m) => ({ ...m, data: content }));
    });
  }
}
