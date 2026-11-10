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
import { AuthEditor } from './auth-editor';
import { Collection, CollectionItem, asCollection } from '../domain/models';
import { AuthDraft, Inheritance, inheritedAuth, withOAuth2Token } from '../domain/auth';
import { itemAt } from '../domain/collection-tree';
import { VariableRow, emptyVariable, requestAncestors, toVariableRows } from '../domain/variables';
import {
  CollectionSettingsModel,
  collectionAuth,
  collectionEvents,
  readCollectionSettings,
} from '../domain/collection-settings';
import { CodeEditor } from './code-editor';

/** The collection, and the folder of it when one is being edited. */
interface Target {
  id: string;
  collection: Collection;
  path: number[];
  folder?: CollectionItem;
}

/**
 * Variables, authorization and scripts that the requests of a collection or of one of its
 * folders inherit. Folders can also inherit the authorization of the folder or collection
 * above them, as in Postman.
 */
@Component({
  imports: [TranslocoPipe, FormField, VariableEditor, AuthEditor, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-collection-settings-panel',
  styleUrl: './collection-settings-panel.scss',
  templateUrl: './collection-settings-panel.html',
})
export class CollectionSettingsPanel {
  protected readonly state = inject(WorkspaceState);
  protected readonly tab = this.state.settingsTab;
  protected readonly rows = signal<VariableRow[]>([emptyVariable()]);
  protected readonly model = signal<CollectionSettingsModel>(readCollectionSettings(undefined));
  protected readonly fields = form(this.model);
  protected readonly dirty = signal(false);
  protected readonly target = computed<Target | undefined>(() => {
    const id = this.state.settingsCollectionId();
    const document = this.state.collections().find((d) => d.id === id);
    if (!document) return undefined;
    try {
      const collection = asCollection(document.value);
      const path = this.state.settingsPath();
      const folder = path.length ? itemAt(collection, path) : undefined;
      // A folder that moved or was removed falls back to the collection itself.
      if (path.length && !folder?.item) return { id, collection, path: [] };
      return { id, collection, path, folder };
    } catch {
      return undefined;
    }
  });
  /** What the folder receives when it inherits its authorization. */
  protected readonly inheritance = computed<Inheritance | undefined>(() => {
    const target = this.target();
    return target?.folder ? { source: inheritedAuth(target.collection, target.path) } : undefined;
  });
  constructor() {
    // Reload the editor whenever another collection or folder is chosen, but not when a
    // document is saved meanwhile: that would discard unsaved edits.
    effect(() => {
      this.state.settingsCollectionId();
      this.state.settingsPath();
      untracked(() => this.load(this.target()));
    });
  }
  protected load(target: Target | undefined) {
    const group = target?.folder ?? target?.collection;
    const rows = toVariableRows(group?.['variable']);
    this.rows.set(rows.length ? rows : [emptyVariable()]);
    this.model.set(readCollectionSettings(group, !!target?.folder));
    this.dirty.set(false);
  }
  protected select(event: Event) {
    this.state.openCollectionSettings((event.target as HTMLSelectElement).value, [], this.tab());
  }
  protected openCollection() {
    const target = this.target();
    if (target) this.state.openCollectionSettings(target.id, [], this.tab());
  }
  /** Opens the folder or collection that the edited folder inherits its authorization from. */
  protected openInherited() {
    const target = this.target();
    if (!target) return;
    const path = this.inheritance()?.source?.path ?? [];
    this.state.openCollectionSettings(target.id, path, 'authorization');
  }
  protected editRows(rows: VariableRow[]) {
    this.rows.set(rows);
    this.dirty.set(true);
  }
  protected editAuth(auth: AuthDraft) {
    this.model.update((m) => ({ ...m, auth }));
    this.dirty.set(true);
  }
  /** "Get new access token" or "Refresh", with the variables of this collection or folder. */
  protected async requestToken(refresh: boolean) {
    const target = this.target();
    if (!target) return;
    const ancestors = requestAncestors(target.collection, [...target.path, 0]);
    // The token is selected and saved in this folder or collection right away; other
    // unsaved changes here stay unsaved.
    await this.state.oauth2Token(this.model().auth, ancestors, refresh, async (token) => {
      const auth = withOAuth2Token(this.model().auth, token);
      this.model.update((m) => ({ ...m, auth }));
      await this.state.keepAuth(target.id, target.path, auth);
      return 'saved';
    });
  }
  protected async save() {
    const target = this.target();
    if (!target) return;
    const m = this.model();
    const folder = !!target.folder;
    await this.state.saveCollectionSettings(
      target.id,
      {
        variables: this.rows(),
        auth: collectionAuth(m, folder),
        event: collectionEvents(m, (target.folder ?? target.collection)['event']),
      },
      target.path,
    );
    if (!this.state.error()) this.dirty.set(false);
  }
  protected markDirty() {
    this.dirty.set(true);
  }
}
