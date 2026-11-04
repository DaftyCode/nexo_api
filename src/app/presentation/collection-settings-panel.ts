import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { VariableEditor } from './variable-editor';
import { asCollection } from '../domain/models';
import { VariableRow, emptyVariable, toVariableRows } from '../domain/variables';
import {
  CollectionSettingsModel,
  collectionAuth,
  collectionEvents,
  readCollectionSettings,
} from '../domain/collection-settings';

/** Variables, authorization and scripts that every request of a collection inherits. */
@Component({
  imports: [TranslocoPipe, FormField, VariableEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-collection-settings-panel',
  styleUrl: './collection-settings-panel.scss',
  templateUrl: './collection-settings-panel.html',
})
export class CollectionSettingsPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly tab = signal<'variables' | 'authorization' | 'scripts'>('variables');
  protected readonly rows = signal<VariableRow[]>([emptyVariable()]);
  protected readonly model = signal<CollectionSettingsModel>(readCollectionSettings(undefined));
  protected readonly fields = form(this.model);
  protected readonly dirty = signal(false);
  protected readonly collection = computed(() =>
    this.state.collections().find((d) => d.id === this.state.settingsCollectionId()),
  );
  constructor() {
    // Reload the editor whenever another collection is chosen.
    effect(() => {
      const id = this.state.settingsCollectionId();
      untracked(() => this.load(id));
    });
  }
  protected load(id: string) {
    const document = this.state.collections().find((d) => d.id === id);
    if (!document) {
      this.rows.set([emptyVariable()]);
      this.model.set(readCollectionSettings(undefined));
      return;
    }
    try {
      const collection = asCollection(document.value);
      const rows = toVariableRows(collection['variable']);
      this.rows.set(rows.length ? rows : [emptyVariable()]);
      this.model.set(readCollectionSettings(collection));
    } catch {
      this.rows.set([emptyVariable()]);
      this.model.set(readCollectionSettings(undefined));
    }
    this.dirty.set(false);
  }
  protected select(event: Event) {
    this.state.settingsCollectionId.set((event.target as HTMLSelectElement).value);
  }
  protected editRows(rows: VariableRow[]) {
    this.rows.set(rows);
    this.dirty.set(true);
  }
  protected async save() {
    const document = this.collection();
    if (!document) return;
    const m = this.model();
    await this.state.saveCollectionSettings(document.id, {
      variables: this.rows(),
      auth: collectionAuth(m),
      event: collectionEvents(m, asCollection(document.value)['event']),
    });
    if (!this.state.error()) this.dirty.set(false);
  }
  protected markDirty() {
    this.dirty.set(true);
  }
}
