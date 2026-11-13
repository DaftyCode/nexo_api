import {
  ApiPort,
  ExecuteArgs,
  FilePort,
  PreferencePort,
  SignInWindowPort,
  noSignInWindow,
} from './ports';
import { GraphQLSchema, INTROSPECTION_QUERY, readSchema } from '../domain/graphql-schema';
import {
  AttachedFile,
  Collection,
  ExecutionResponse,
  MAX_REQUEST_FILES,
  RequestDraft,
  requestFiles,
  WorkspaceDocument,
  schema,
  toItem,
  updateItem,
  asCollection,
} from '../domain/models';
import { toPortableRows } from '../domain/variables';
import { CookieCases } from './workspace-use-cases/cookies';
import { OAuth2Cases } from './workspace-use-cases/oauth2';
import {
  ExecutionContext,
  WorkspaceExecuteArgs,
  createDocument,
} from './workspace-use-cases/types';
import { VariableCases } from './workspace-use-cases/variables';
import { SessionCases } from './workspace-use-cases/sessions';

export type {
  ExecutionContext,
  PastedOAuth2Token,
  ScriptVariables,
  VariableTargets,
  WorkspaceExecuteArgs,
} from './workspace-use-cases/types';
export { CookieCases, OAuth2Cases, SessionCases, VariableCases };

const memoryPreferences = (): PreferencePort => {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key),
    write: (key, value) => void (value ? values.set(key, value) : values.delete(key)),
  };
};

/**
 * Workspaces and their documents, and sending requests. OAuth 2.0 tokens, cookies and
 * variables are areas of their own.
 */
export class WorkspaceUseCases {
  readonly oauth2: OAuth2Cases;
  readonly cookies: CookieCases;
  readonly variables: VariableCases;
  /** The tabs and the order of collections a workspace opens with. */
  readonly sessions: SessionCases;

  constructor(
    private readonly api: ApiPort,
    readonly files: FilePort,
    preferences: PreferencePort = memoryPreferences(),
    signInWindow: SignInWindowPort = noSignInWindow,
  ) {
    this.oauth2 = new OAuth2Cases(api, signInWindow);
    this.cookies = new CookieCases(api);
    this.variables = new VariableCases(api, files, preferences);
    this.sessions = new SessionCases(api, preferences);
  }

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
  createDocument(
    workspace: string,
    kind: string,
    name: string,
    value: unknown,
  ): Promise<WorkspaceDocument> {
    return createDocument(this.api, this.files.id(), workspace, kind, name, value);
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
    const files = requestFiles(request);
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
      ...(files.length ? { files } : {}),
    });
  }
  /**
   * Loads the schema of a GraphQL endpoint by introspection, with the URL, headers,
   * authorization and variables of the request, as Postman does. Scripts are not run.
   */
  async introspect(
    request: RequestDraft,
    context: ExecutionContext,
    id: string,
  ): Promise<GraphQLSchema> {
    const response = await this.send(
      {
        ...request,
        protocol: 'graphql',
        method: 'POST',
        body: INTROSPECTION_QUERY,
        graphqlVariables: '{}',
        prerequest: '',
        tests: '',
      },
      { ...context, ancestors: context.ancestors.map(({ event: _event, ...rest }) => rest) },
      id,
    );
    if (response.error) throw new Error(response.error);
    if (response.status >= 400 && !response.body.includes('__schema'))
      throw new Error(`The server did not answer with a GraphQL schema (HTTP ${response.status})`);
    return readSchema(response.body);
  }
  /** Reads a file chosen to send with a request; its content stays in the open request. */
  async attachFile(file: File): Promise<AttachedFile> {
    if (file.size > MAX_REQUEST_FILES)
      throw new Error('Files sent with a request can add up to 32 MB');
    return {
      name: file.name,
      contentType: file.type,
      size: file.size,
      content: await this.files.readBase64(file),
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
  /** Downloads a collection or environment as JSON; returns the name of the file. */
  export(document: WorkspaceDocument) {
    const name = `${document.name.replace(/[^\w .-]/g, '_')}.${document.kind === 'environment' ? 'environment' : 'collection'}.json`;
    this.files.download(name, JSON.stringify(document.value, null, 2));
    return name;
  }
}
