import { computed, signal } from '@angular/core';
import { WorkspaceDocument } from '../../domain/models';
import { VariableRow } from '../../domain/variables';
import { StateContext } from './state-context';

/** Documents of the current workspace, kept in sync with saves instead of full reloads. */
export class DocumentsStore {
  readonly documents = signal<WorkspaceDocument[]>([]);
  readonly collections = computed(() => this.documents().filter((d) => d.kind === 'collection'));
  readonly environments = computed(() => this.documents().filter((d) => d.kind === 'environment'));
  readonly history = computed(() => this.documents().filter((d) => d.kind === 'history'));
  readonly globalsDocument = computed(() => this.documents().find((d) => d.kind === 'globals'));

  constructor(private readonly context: StateContext) {}

  async refresh() {
    this.documents.set(await this.context.cases.documents(this.context.workspaceId()));
  }
  /** Replaces saved documents locally so the UI does not reload the whole workspace. */
  applySaved(saved: WorkspaceDocument[]) {
    if (!saved.length) return;
    this.documents.update((documents) => {
      const next = [...documents];
      for (const document of saved) {
        const index = next.findIndex((d) => d.id === document.id);
        if (index < 0) next.push(document);
        else next[index] = document;
      }
      return next;
    });
  }
  forget(document: WorkspaceDocument) {
    this.documents.update((documents) => documents.filter((d) => d.id !== document.id));
  }
  async remove(document: WorkspaceDocument) {
    await this.context.cases.removeDocument(document);
    this.forget(document);
  }
  async createCollection(name: string) {
    const created = await this.context.cases.createCollection(this.context.workspaceId(), name);
    this.applySaved([created]);
    return created;
  }
  /** Imports a collection, environment or definition; returns the document created. */
  async importContent(content: string) {
    const created = await this.context.cases.import(this.context.workspaceId(), content);
    await this.refresh();
    return created;
  }
  async saveCollectionSettings(
    id: string,
    settings: { variables: readonly VariableRow[]; auth?: unknown; event?: unknown },
    folder: readonly number[] = [],
  ) {
    const document = this.collections().find((d) => d.id === id);
    if (!document) throw new Error('Choose a collection');
    this.applySaved([
      await this.context.cases.variables.saveCollectionSettings(document, settings, folder),
    ]);
  }
  /** Keeps the most recent history entries; older ones are removed in the background. */
  async pruneHistory(keep = 200) {
    const old = this.history()
      .slice()
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(keep);
    for (const document of old) {
      try {
        await this.remove(document);
      } catch {
        return;
      }
    }
  }
}
