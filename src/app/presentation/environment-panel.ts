import { TranslocoPipe } from '@jsverse/transloco';
import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  effect,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { VariableEditor } from './variable-editor';
import { VariableRow, emptyVariable, toVariableRows } from '../domain/variables';
import {
  ENVIRONMENT_COLORS,
  EnvironmentProtection,
  readEnvironmentSettings,
} from '../domain/environment-protection';

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
  protected readonly colors = ENVIRONMENT_COLORS;
  protected readonly model = signal({
    id: '',
    name: 'New environment',
    color: '',
    protection: 'none' as EnvironmentProtection,
  });
  protected readonly rows = signal<VariableRow[]>([
    emptyVariable('base_url', 'http://localhost:8080'),
  ]);
  protected readonly dirty = signal(false);
  protected readonly fields = form(this.model);
  protected readonly isGlobals = computed(() => this.model().id === GLOBALS);
  protected readonly current = computed(() =>
    this.state.environments().find((d) => d.id === this.model().id),
  );
  /** The revision of the variable set when it was loaded into the editor. */
  private readonly loadedRevision = signal(0);
  /** The document being edited: the globals or an environment. */
  private readonly source = computed(() =>
    this.isGlobals() ? this.state.globalsDocument() : this.current(),
  );
  /** The variables changed after they were loaded, for example by a script. */
  protected readonly changed = computed(
    () => !!this.model().id && (this.source()?.revision ?? 0) !== this.loadedRevision(),
  );
  constructor() {
    const active = this.state.environmentId();
    if (active) this.load(active);
    // Without edits of its own, the editor shows the latest values at once.
    effect(() => {
      if (this.changed() && !untracked(this.dirty)) untracked(() => this.load(this.model().id));
    });
  }
  load(id: string) {
    this.dirty.set(false);
    if (id === GLOBALS) {
      this.model.set({ id: GLOBALS, name: 'Globals', color: '', protection: 'none' });
      this.loadedRevision.set(this.state.globalsDocument()?.revision ?? 0);
      const rows = this.state.globalRows();
      this.rows.set(rows.length ? rows : [emptyVariable()]);
      return;
    }
    const document = this.state.environments().find((x) => x.id === id);
    if (!document) {
      this.model.set({ id: '', name: 'New environment', color: '', protection: 'none' });
      this.loadedRevision.set(0);
      this.rows.set([emptyVariable()]);
      return;
    }
    const rows = toVariableRows((document.value as { values?: unknown })?.values);
    this.model.set({ id: document.id, name: document.name, ...this.settingsOf(document.value) });
    this.loadedRevision.set(document.revision);
    this.rows.set(rows.length ? rows : [emptyVariable()]);
  }
  /** Discards the edits and shows the latest values. */
  protected reload() {
    this.load(this.model().id);
  }
  /** The colour and protection of an environment, for its entry in the list too. */
  protected settingsOf(value: unknown) {
    return readEnvironmentSettings(value);
  }
  protected setColor(color: string) {
    this.model.update((model) => ({ ...model, color }));
    this.dirty.set(true);
  }
  private settings() {
    const { color, protection } = this.model();
    return { color, protection };
  }
  protected editRows(rows: VariableRow[]) {
    this.rows.set(rows);
    this.dirty.set(true);
  }
  protected async save() {
    const m = this.model();
    // The values changed after they were loaded: saving would replace them.
    if (
      this.changed() &&
      !this.state.confirm(
        'These variables changed since you opened them, for example by a script. Save your changes over them?',
      )
    ) {
      this.reload();
      this.state.variablesReloaded();
      return;
    }
    const result =
      m.id === GLOBALS
        ? await this.state.saveGlobals(this.rows())
        : await this.state.saveEnvironment(m.id, m.name, this.rows(), this.settings());
    // A failure keeps the edits, and a toast says why.
    if (!result) return;
    // Saved, or kept as changed elsewhere: the editor shows what is stored now.
    this.load(m.id === GLOBALS ? GLOBALS : (result.saved?.id ?? m.id));
  }
  protected async duplicate() {
    const m = this.model();
    const copy = `${m.name} copy`;
    const saved = (await this.state.saveEnvironment('', copy, this.rows(), this.settings()))?.saved;
    if (saved) this.load(saved.id);
  }
  protected activate() {
    this.state.selectEnvironment(this.model().id);
  }
  protected async remove() {
    const document = this.current();
    if (!document) return;
    if (await this.state.remove(document)) this.load('');
  }
  protected count(value: unknown) {
    return toVariableRows((value as { values?: unknown } | undefined)?.values).filter(
      (row) => row.key,
    ).length;
  }
}
