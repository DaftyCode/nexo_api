import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import {
  BUILTIN_TYPES,
  ConnectionTypeChoice,
  connectionTypeForm,
  connectionTypeProblem,
} from '../domain/db/connection-types';
import { CONNECTION_COLORS } from '../domain/mongo';
import { PanelTask } from './panel-task';
import { WorkspaceState, success } from './workspace-state';

/**
 * Settings → Connection types (DB-25): the three built in, and the person's own with their
 * color and what every session of their connections does. The engine applies the rules.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-connection-types-settings',
  templateUrl: './connection-types-settings.html',
  styleUrl: './db-connection-editor.scss',
})
export class ConnectionTypesSettings {
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  protected readonly builtin = BUILTIN_TYPES;
  protected readonly colors = CONNECTION_COLORS;
  protected readonly own = computed(() =>
    this.state.cases.connectionTypes.own(this.state.documents()),
  );
  /** The type in the form: its id, `new`, or none when the form is closed. */
  protected readonly editing = signal<string | undefined>(undefined);
  protected readonly model = signal(connectionTypeForm());
  protected readonly fields = form(this.model);
  protected readonly problem = computed(() => connectionTypeProblem(this.model()));

  /** The rules of a type, as message keys. */
  protected said(type: ConnectionTypeChoice): string[] {
    const { rules } = type;
    return [
      rules.autoCommit ? 'Commits each statement' : 'Commits by hand',
      ...(rules.confirmWrites ? ['Confirms each change'] : []),
      ...(rules.confirmStructure && !rules.confirmWrites ? ['Confirms changes of structure'] : []),
      ...(rules.readOnly ? ['Read-only'] : []),
    ];
  }
  protected create() {
    this.model.set(connectionTypeForm());
    this.editing.set('new');
  }
  protected edit(type: ConnectionTypeChoice) {
    this.model.set(connectionTypeForm(type));
    this.editing.set(type.id);
  }
  protected setColor(color: string) {
    this.model.update((model) => ({ ...model, color }));
  }
  protected save() {
    const editing = this.editing();
    if (!editing || this.problem()) return;
    void this.task.announce('The connection type could not be saved', async () => {
      const id = editing === 'new' ? this.state.cases.files.id() : editing;
      const existing = this.state.documents().find((document) => document.id === id);
      const saved = await this.state.cases.connectionTypes.save(
        this.state.workspaceId(),
        id,
        this.model(),
        existing,
      );
      this.state.applySaved([saved]);
      this.editing.set(undefined);
      return success('Connection type saved', 'toast.connectionTypeSaved', { v0: saved.name });
    });
  }
  protected remove(type: ConnectionTypeChoice) {
    const documents = this.state.documents();
    const document = documents.find((each) => each.id === type.id);
    if (!document) return;
    const users = this.state.cases.connectionTypes.users(type.id, documents);
    if (users.length) {
      this.task.error.set(
        users.length === 1
          ? 'A connection has this type: give it another one first'
          : 'Several connections have this type: give them another one first',
      );
      return;
    }
    if (!this.state.confirm('Delete this connection type?')) return;
    void this.task.announce('The connection type could not be deleted', async () => {
      await this.state.cases.connectionTypes.remove(document);
      this.state.forget(document);
      return success('Connection type deleted', 'toast.connectionTypeDeleted', { v0: type.name });
    });
  }
}
