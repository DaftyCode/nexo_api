import { ApiPort, ExecuteArgs, FilePort, PreferencePort } from './ports';
import { ExecutionOperation } from './operations';
import { PayloadOf } from './payloads';
import { itemAt } from '../domain/collection-tree';
import { OAuth2SignIn, OAuth2SignInStatus, OAuth2Token, OAuth2TokenDetails } from '../domain/auth';
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

/** An operation and its payload without the workspace, which `execute` adds. */
export type WorkspaceExecuteArgs = {
  [O in ExecutionOperation]: [operation: O, payload?: Omit<PayloadOf<O>, 'workspace'>];
}[ExecutionOperation];

/** Variable scopes and inherited configuration used to execute a request. */
export interface ExecutionContext {
  /** Workspace that scopes the execution, such as its cookie jar. */
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

  /** Runs an engine operation in a workspace; its payload is checked against its type. */
  execute<T>(workspace: string, ...[operation, payload]: WorkspaceExecuteArgs) {
    return this.api.execute<T>(...([operation, { ...payload, workspace }] as ExecuteArgs));
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
  /**
   * "Get New Access Token" or, with a refresh token, its renewal for an OAuth 2.0
   * authorization. The engine resolves its variables and vault secrets as for a request.
   */
  oauth2Token(auth: unknown, context: ExecutionContext, tokenId?: string) {
    return this.api.execute<OAuth2Token>('oauth2.token', {
      ...this.authorizationPayload(auth, context),
      ...(tokenId ? { tokenId } : {}),
    });
  }
  /** Stored tokens ("Available Tokens") without their values. */
  async oauth2Tokens(workspace: string) {
    const { tokens } = await this.api.execute<{ tokens: OAuth2Token[] }>('oauth2.tokens', {
      workspace,
      action: 'list',
    });
    return tokens;
  }
  /** Every value of a stored token, for "Manage Tokens". */
  oauth2TokenDetails(workspace: string, id: string) {
    return this.api.execute<OAuth2TokenDetails>('oauth2.tokens', {
      workspace,
      action: 'details',
      id,
    });
  }
  deleteOAuth2Token(workspace: string, id: string) {
    return this.api.execute('oauth2.tokens', { workspace, action: 'delete', id });
  }
  /** Starts a browser sign-in (authorization code, PKCE or implicit). */
  oauth2Authorize(auth: unknown, context: ExecutionContext) {
    return this.api.execute<OAuth2SignIn>('oauth2.authorize', {
      ...this.authorizationPayload(auth, context),
      action: 'start',
    });
  }
  /** `status`, `open` (the browser again), `complete` (with the returned address) or `cancel`. */
  oauth2SignIn(
    workspace: string,
    session: string,
    action: 'status' | 'open' | 'complete' | 'cancel',
    url?: string,
  ) {
    return this.api.execute<OAuth2SignInStatus>('oauth2.authorize', {
      workspace,
      session,
      action,
      ...(url ? { url } : {}),
    });
  }
  /** The authorization and the scopes its variables are resolved in. */
  private authorizationPayload(auth: unknown, context: ExecutionContext) {
    return {
      ...(context.workspace ? { workspace: context.workspace } : {}),
      request: {
        name: 'OAuth 2.0',
        request: { method: 'GET', url: 'https://oauth2.invalid/', auth },
      },
      variables: toPortableRows(context.environment),
      globals: toPortableRows(context.globals),
      context: { ancestors: context.ancestors },
    };
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

  /**
   * Variables, auth and scripts of the collection root or, with a `folder` path, of that
   * folder. A folder without variables stores none.
   */
  async saveCollectionSettings(
    document: WorkspaceDocument,
    settings: { variables: readonly VariableRow[]; auth?: unknown; event?: unknown },
    folder: readonly number[] = [],
  ) {
    const value: Collection = structuredClone(asCollection(document.value));
    const group: Record<string, unknown> | undefined = folder.length
      ? itemAt(value, folder)
      : value;
    if (!group || (folder.length && !Array.isArray(group['item'])))
      throw new Error('Folder not found');
    const variables = toCollectionVariables(settings.variables);
    if (folder.length && !variables.length) delete group['variable'];
    else group['variable'] = variables;
    if (settings.auth === undefined) delete group['auth'];
    else group['auth'] = settings.auth;
    if (settings.event === undefined) delete group['event'];
    else group['event'] = settings.event;
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
