import { computed, signal } from '@angular/core';
import { failureCode } from '../../application/ports';
import { ExecutionResponse, WorkspaceDocument } from '../../domain/models';
import { VariableRow, toPortableRows, toVariableRows } from '../../domain/variables';
import { DocumentsStore } from './documents-store';
import { StateContext } from './state-context';

/** The active environment, global variables and the values scripts change. */
export class VariablesStore {
  readonly environmentId = signal('');
  readonly environmentDocument = computed(() =>
    this.documents.environments().find((d) => d.id === this.environmentId()),
  );
  readonly environmentRows = computed<VariableRow[]>(() =>
    toVariableRows((this.environmentDocument()?.value as { values?: unknown } | undefined)?.values),
  );
  readonly globalRows = computed<VariableRow[]>(() =>
    toVariableRows(
      (this.documents.globalsDocument()?.value as { values?: unknown } | undefined)?.values,
    ),
  );
  /** Environment rows in the portable shape the runtime expects. */
  readonly variables = computed(() => toPortableRows(this.environmentRows()));

  constructor(
    private readonly context: StateContext,
    private readonly documents: DocumentsStore,
  ) {}

  /** Selects the active environment and remembers it for this workspace on this device. */
  select(id: string) {
    this.environmentId.set(this.documents.environments().some((d) => d.id === id) ? id : '');
    this.context.cases.rememberEnvironment(this.context.workspaceId(), this.environmentId());
  }
  /** Selects the environment remembered for the current workspace, if it still exists. */
  restore() {
    const remembered = this.context.cases.rememberedEnvironment(this.context.workspaceId());
    if (remembered && this.documents.environments().some((d) => d.id === remembered))
      this.environmentId.set(remembered);
  }
  /** Clears the selection when its environment no longer exists. */
  validate() {
    if (this.environmentId() && !this.environmentDocument()) this.environmentId.set('');
  }
  /**
   * Saves an environment. Returns `undefined` when it changed elsewhere and the person
   * chose to keep that version.
   */
  async saveEnvironment(id: string, name: string, rows: readonly VariableRow[]) {
    const workspace = this.context.workspaceId();
    const existing = this.documents.environments().find((d) => d.id === id);
    const saved = await this.overLatest(
      () => this.context.cases.saveEnvironment(workspace, existing, name, rows),
      () => {
        const latest = this.documents.environments().find((d) => d.id === id);
        return latest && this.context.cases.saveEnvironment(workspace, latest, name, rows);
      },
    );
    if (saved && !existing && !this.environmentId()) this.select(saved.id);
    return saved;
  }
  /** Saves the global variables, as `saveEnvironment` does. */
  async saveGlobals(rows: readonly VariableRow[]) {
    const workspace = this.context.workspaceId();
    return this.overLatest(
      () => this.context.cases.saveGlobals(workspace, this.documents.globalsDocument(), rows),
      () => this.context.cases.saveGlobals(workspace, this.documents.globalsDocument(), rows),
    );
  }
  /**
   * Saves, and when the document changed in the meantime (409, from another window or
   * device), reloads it and asks before saving over the latest version, as for collections.
   */
  private async overLatest(
    save: () => Promise<WorkspaceDocument>,
    again: () => Promise<WorkspaceDocument> | undefined,
  ): Promise<WorkspaceDocument | undefined> {
    let saved: WorkspaceDocument;
    try {
      saved = await save();
    } catch (error) {
      if (failureCode(error) !== 'conflict') throw error;
      await this.documents.refresh();
      const message =
        'These variables changed since you opened them. Save your changes over the latest version?';
      const retried = this.context.confirm(message) ? again() : undefined;
      if (!retried) {
        this.context.status.notice.set('Variables reloaded');
        return undefined;
      }
      saved = await retried;
    }
    this.documents.applySaved([saved]);
    return saved;
  }
  /** Saves the values scripts changed; a failure never hides a successful response. */
  async persist(
    variables: ExecutionResponse['variables'],
    environment: WorkspaceDocument | undefined,
    collection: WorkspaceDocument | undefined,
  ): Promise<WorkspaceDocument[]> {
    try {
      const saved = await this.context.cases.persistScriptVariables(variables, {
        workspace: this.context.workspaceId(),
        environment,
        globals: this.documents.globalsDocument(),
        collection,
      });
      if (saved.length) this.context.status.notice.set('Variables updated by scripts');
      return saved;
    } catch (error) {
      this.context.status.error.set(this.context.status.describe(error));
      return [];
    }
  }
}
