import { TranslocoPipe } from '@jsverse/transloco';
import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { KeyValueEditor } from './key-value-editor';
import { KeyValue, row } from '../domain/models';

@Component({
  imports: [TranslocoPipe, FormField, KeyValueEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-environment-panel',
  styleUrl: './environment-panel.scss',
  templateUrl: './environment-panel.html',
})
export class EnvironmentPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly model = signal({
    id: '',
    name: 'New environment',
    values: [row('base_url', 'http://localhost:8080')],
  });
  protected readonly fields = form(this.model);
  protected load(id: string) {
    const d = this.state.environments().find((x) => x.id === id);
    this.model.set(
      d
        ? { id: d.id, name: d.name, values: (d.value as { values: KeyValue[] }).values ?? [] }
        : { id: '', name: 'New environment', values: [row()] },
    );
  }
  protected rows(values: KeyValue[]) {
    this.model.update((m) => ({ ...m, values }));
  }
  protected save() {
    const m = this.model();
    void this.state.saveEnvironment(m.id, m.name, m.values);
  }
}
