import { TranslocoPipe } from '@jsverse/transloco';
import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { VariableEditor } from './variable-editor';
import { VariableRow, emptyVariable, toVariableRows } from '../domain/variables';

/** Identifier of the workspace globals entry in the list of variable sets. */
export const GLOBALS = '__globals';

@Component({
  imports: [TranslocoPipe, FormField, VariableEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-environment-panel',
  styleUrl: './environment-panel.scss',
  templateUrl: './environment-panel.html',
})
export class EnvironmentPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly globalsId = GLOBALS;
  protected readonly model = signal({ id: '', name: 'New environment' });
  protected readonly rows = signal<VariableRow[]>([
    emptyVariable('base_url', 'http://localhost:8080'),
  ]);
  protected readonly dirty = signal(false);
  protected readonly fields = form(this.model);
  protected readonly isGlobals = computed(() => this.model().id === GLOBALS);
  protected readonly current = computed(() =>
    this.state.environments().find((d) => d.id === this.model().id),
  );
  constructor() {
    const active = this.state.environmentId();
    if (active) this.load(active);
  }
  load(id: string) {
    this.dirty.set(false);
    if (id === GLOBALS) {
      this.model.set({ id: GLOBALS, name: 'Globals' });
      const rows = this.state.globalRows();
      this.rows.set(rows.length ? rows : [emptyVariable()]);
      return;
    }
    const document = this.state.environments().find((x) => x.id === id);
    if (!document) {
      this.model.set({ id: '', name: 'New environment' });
      this.rows.set([emptyVariable()]);
      return;
    }
    const rows = toVariableRows((document.value as { values?: unknown })?.values);
    this.model.set({ id: document.id, name: document.name });
    this.rows.set(rows.length ? rows : [emptyVariable()]);
  }
  protected editRows(rows: VariableRow[]) {
    this.rows.set(rows);
    this.dirty.set(true);
  }
  protected async save() {
    const m = this.model();
    if (m.id === GLOBALS) await this.state.saveGlobals(this.rows());
    else {
      const saved = await this.state.saveEnvironment(m.id, m.name, this.rows());
      if (saved) this.model.set({ id: saved.id, name: saved.name });
    }
    if (!this.state.error()) this.dirty.set(false);
  }
  protected async duplicate() {
    const m = this.model();
    const saved = await this.state.saveEnvironment('', `${m.name} copy`, this.rows());
    if (saved) this.load(saved.id);
  }
  protected activate() {
    this.state.selectEnvironment(this.model().id);
  }
  protected async remove() {
    const document = this.current();
    if (!document) return;
    await this.state.remove(document);
    this.load('');
  }
  protected count(value: unknown) {
    return toVariableRows((value as { values?: unknown } | undefined)?.values).filter(
      (row) => row.key,
    ).length;
  }
}
