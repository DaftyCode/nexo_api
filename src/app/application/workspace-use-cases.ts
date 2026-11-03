import { ApiPort, FilePort } from './ports';
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
export class WorkspaceUseCases {
  constructor(
    readonly api: ApiPort,
    readonly files: FilePort,
  ) {}
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
  async send(request: RequestDraft, variables: unknown[], id: string): Promise<ExecutionResponse> {
    if (!request.url.trim()) throw new Error('Enter a request URL');
    const text = JSON.stringify(request);
    const secretNames = [
      ...new Set([...text.matchAll(/\{\{vault:([^}]+)\}\}/g)].map((match) => match[1])),
    ];
    return this.api.execute<ExecutionResponse>('request', {
      id,
      request,
      variables,
      secretNames,
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
}
