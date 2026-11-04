import { computed, signal } from '@angular/core';
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
  async saveEnvironment(id: string, name: string, rows: readonly VariableRow[]) {
    const existing = this.documents.environments().find((d) => d.id === id);
    const saved = await this.context.cases.saveEnvironment(
      this.context.workspaceId(),
      existing,
      name,
      rows,
    );
    this.documents.applySaved([saved]);
    if (!existing && !this.environmentId()) this.select(saved.id);
    return saved;
  }
  async saveGlobals(rows: readonly VariableRow[]) {
    this.documents.applySaved([
      await this.context.cases.saveGlobals(
        this.context.workspaceId(),
        this.documents.globalsDocument(),
        rows,
      ),
    ]);
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
