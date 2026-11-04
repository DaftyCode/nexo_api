import { ApiPort, FilePort, PreferencePort } from './ports';
import { ExecutionOperation } from './operations';
import {
  Collection,
  ExecutionResponse,
  RequestDraft,
  WorkspaceDocument,
  schema,
  toItem,
  updateItem,
  asCollection,
} from '../domain/models';
import {
  RequestAncestor,
  VariableRow,
  applyScriptValues,
  scopeValues,
  toCollectionVariables,
  toPortableRows,
  toVariableRows,
} from '../domain/variables';

/** Variable scopes and inherited configuration used to execute a request. */
export interface ExecutionContext {
  /** Workspace whose role rules apply to the execution. */
  workspace?: string;
  environment: readonly VariableRow[];
  globals: readonly VariableRow[];
  ancestors: readonly RequestAncestor[];
}

/** Documents whose variables scripts may update after an execution. */
export interface VariableTargets {
  environment?: WorkspaceDocument;
  globals?: WorkspaceDocument;
  collection?: WorkspaceDocument;
  workspace: string;
}

/** Engine output with the final value of every scope. */
export interface ScriptVariables {
  environment?: unknown;
  globals?: unknown;
  collection?: unknown;
}

const memoryPreferences = (): PreferencePort => {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key),
    write: (key, value) => void (value ? values.set(key, value) : values.delete(key)),
  };
};

export class WorkspaceUseCases {
  constructor(
    private readonly api: ApiPort,
    readonly files: FilePort,
    private readonly preferences: PreferencePort = memoryPreferences(),
  ) {}

  // Connection and session.
  initialize() {
    return this.api.initialize();
  }
  health() {
    return this.api.health();
  }
  signOut() {
    return this.api.signOut();
  }

  // Local workspaces.
  workspaces() {
    return this.api.workspaces();
  }
  createWorkspace(name: string) {
    if (!name.trim()) throw new Error('A name is required');
    return this.api.createWorkspace(name.trim());
  }
  renameWorkspace(id: string, name: string) {
    if (!name.trim()) throw new Error('A name is required');
    return this.api.renameWorkspace(id, name.trim());
  }
  deleteWorkspace(id: string) {
    return this.api.deleteWorkspace(id);
  }

  // Documents.
  documents(workspace: string) {
    return this.api.documents(workspace);
  }
  /** A document with its value, for entries the listing returns without one. */
  async loaded(document: WorkspaceDocument) {
    return document.value === null || document.value === undefined
      ? this.api.document(document.id)
      : document;
  }
  saveDocument(document: WorkspaceDocument) {
    return this.api.save(document);
  }
  removeDocument(document: WorkspaceDocument) {
    return this.api.remove(document);
  }

  /** Runs an engine operation in a workspace. */
  execute<T>(
    workspace: string,
    operation: ExecutionOperation,
    payload: Record<string, unknown> = {},
  ) {
    return this.api.execute<T>(operation, { ...payload, workspace });
  }
  async createDocument(
    workspace: string,
    kind: string,
    name: string,
    value: unknown,
  ): Promise<WorkspaceDocument> {
    if (!name.trim()) throw new Error('A name is required');
    return this.api.save({
      id: this.files.id(),
      workspace_id: workspace,
      kind,
      name: name.trim(),
      revision: 0,
      updated_at: 0,
      value,
    });
  }
  createCollection(workspace: string, name: string) {
    return this.createDocument(workspace, 'collection', name, {
      info: { name, schema },
      item: [],
    } satisfies Collection);
  }
  async send(
    request: RequestDraft,
    context: ExecutionContext,
    id: string,
  ): Promise<ExecutionResponse> {
    if (!request.url.trim()) throw new Error('Enter a request URL');
    // The backend finds `{{vault:name}}` references itself and resolves them for this actor.
    return this.api.execute<ExecutionResponse>('request', {
      ...(context.workspace ? { workspace: context.workspace } : {}),
      id,
      // The engine receives the same collection item that saving would store.
      request: toItem(request),
      variables: toPortableRows(context.environment),
      globals: toPortableRows(context.globals),
      context: { ancestors: context.ancestors },
      timeout: request.timeout,
      strictSSL: request.strictSSL,
      followRedirects: request.followRedirects,
    });
  }
  async saveRequest(document: WorkspaceDocument, path: number[], request: RequestDraft) {
    const collection = asCollection(document.value);
    let existing = collection.item[path[0]];
    for (const index of path.slice(1)) existing = existing?.item?.[index] ?? existing;
    const value = updateItem(collection, path, toItem(request, existing));
    return this.api.save({ ...document, value });
  }
  async import(workspace: string, content: string) {
    const result = await this.api.execute<{ kind: string; name: string; value: unknown }>(
      'import',
      { content },
    );
    return this.createDocument(workspace, result.kind, result.name, result.value);
  }
  export(document: WorkspaceDocument) {
    this.files.download(
      `${document.name.replace(/[^\w .-]/g, '_')}.${document.kind === 'environment' ? 'environment' : 'collection'}.json`,
      JSON.stringify(document.value, null, 2),
    );
  }

  /** The environment selected last time in a workspace on this device. */
  rememberedEnvironment(workspace: string): string {
    return this.preferences.read(`environment.${workspace}`) ?? '';
  }
  rememberEnvironment(workspace: string, environment: string) {
    if (workspace) this.preferences.write(`environment.${workspace}`, environment);
  }

  /** Saves an environment, creating it when `existing` is undefined. */
  saveEnvironment(
    workspace: string,
    existing: WorkspaceDocument | undefined,
    name: string,
    rows: readonly VariableRow[],
  ) {
    const values = toPortableRows(rows);
    if (!name.trim()) throw new Error('A name is required');
    return existing
      ? this.api.save({
          ...existing,
          name: name.trim(),
          value: { ...(existing.value as Record<string, unknown>), name: name.trim(), values },
        })
      : this.createDocument(workspace, 'environment', name, { name: name.trim(), values });
  }

  /** Globals are a single document per workspace, created on first save. */
  saveGlobals(
    workspace: string,
    existing: WorkspaceDocument | undefined,
    rows: readonly VariableRow[],
  ) {
    const values = toPortableRows(rows);
    return existing
      ? this.api.save({ ...existing, value: { ...(existing.value as object), values } })
      : this.createDocument(workspace, 'globals', 'Globals', { name: 'Globals', values });
  }

  /** Collection-level variables, auth and scripts are stored in the collection root. */
  saveCollectionSettings(
    document: WorkspaceDocument,
    settings: { variables: readonly VariableRow[]; auth?: unknown; event?: unknown },
  ) {
    const value: Collection = { ...asCollection(document.value) };
    value['variable'] = toCollectionVariables(settings.variables);
    if (settings.auth === undefined) delete value['auth'];
    else value['auth'] = settings.auth;
    if (settings.event === undefined) delete value['event'];
    else value['event'] = settings.event;
    return this.api.save({ ...document, value });
  }

  /**
   * Writes back the values that scripts set or unset with `nx.environment`, `nx.globals`
   * and `nx.collectionVariables`. Only documents whose values changed are saved.
   */
  async persistScriptVariables(
    variables: ScriptVariables | undefined,
    targets: VariableTargets,
  ): Promise<WorkspaceDocument[]> {
    if (!variables) return [];
    const saved: WorkspaceDocument[] = [];
    if (targets.environment) {
      const current = toVariableRows((targets.environment.value as { values?: unknown })?.values);
      const next = applyScriptValues(current, scopeValues(variables.environment));
      if (next) {
        const name = targets.environment.name;
        saved.push(await this.saveEnvironment(targets.workspace, targets.environment, name, next));
      }
    }
    const currentGlobals = toVariableRows(
      (targets.globals?.value as { values?: unknown } | undefined)?.values,
    );
    const globals = applyScriptValues(currentGlobals, scopeValues(variables.globals));
    if (globals && (targets.globals || globals.some((row) => row.enabled)))
      saved.push(await this.saveGlobals(targets.workspace, targets.globals, globals));
    if (targets.collection) {
      const collection = asCollection(targets.collection.value);
      const current = toVariableRows(collection['variable']);
      const next = applyScriptValues(current, scopeValues(variables.collection));
      if (next)
        saved.push(
          await this.saveCollectionSettings(targets.collection, {
            variables: next,
            auth: collection['auth'],
            event: collection['event'],
          }),
        );
    }
    return saved;
  }
}
