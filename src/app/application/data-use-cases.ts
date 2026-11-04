import { DocumentRepositoryPort, ExecutionPort } from './ports';
import { WorkspaceDocument } from '../domain/models';

export interface DatasetSummary {
  id: string;
  rows: number;
  columns: string[];
}
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
}
export interface MockExample {
  method?: string;
  path?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delay?: number;
}
export interface RunningMock {
  id: string;
  port: number;
  url: string;
  calls?: unknown[];
}

type DataPorts = ExecutionPort & Pick<DocumentRepositoryPort, 'save' | 'remove'>;

/** Datasets queried with read-only SQL and local mock servers. */
export class DataUseCases {
  constructor(
    private readonly api: DataPorts,
    private readonly id: () => string,
  ) {}

  /** Imports rows and keeps a dataset document with the same identifier. */
  async importDataset(
    workspace: string,
    input: { id?: string; name: string; content: string },
    existing: readonly WorkspaceDocument[],
  ): Promise<DatasetSummary> {
    const name = input.name.trim() || 'Dataset';
    const result = await this.api.execute<DatasetSummary>('dataset.import', {
      workspace,
      id: input.id || undefined,
      content: input.content,
    });
    const document = existing.find((d) => d.kind === 'dataset' && d.id === result.id);
    await this.api.save(
      document
        ? { ...document, name, value: result }
        : {
            id: result.id,
            workspace_id: workspace,
            kind: 'dataset',
            name,
            revision: 0,
            updated_at: 0,
            value: result,
          },
    );
    return result;
  }
  queryDataset(workspace: string, id: string, sql: string) {
    if (!id) throw new Error('Import or choose a dataset first');
    return this.api.execute<QueryResult>('dataset.query', { workspace, id, sql });
  }
  async deleteDataset(workspace: string, id: string, document?: WorkspaceDocument) {
    if (!id) throw new Error('Import or choose a dataset first');
    await this.api.execute('dataset.delete', { workspace, id });
    if (document) await this.api.remove(document);
  }
  /** Parses JSON or CSV iteration data without storing it. */
  async parseRows(workspace: string, content: string) {
    const result = await this.api.execute<{ rows: unknown[] }>('dataset.parse', {
      workspace,
      content,
    });
    return result.rows;
  }

  /** Starts a mock and records it as a workspace document. */
  async startMock(workspace: string, port: number, examples: MockExample[]) {
    const result = await this.api.execute<RunningMock>('mock.start', { workspace, port, examples });
    await this.api.save({
      id: this.id(),
      workspace_id: workspace,
      kind: 'mock',
      name: `Mock ${new Date().toLocaleTimeString()}`,
      revision: 0,
      updated_at: 0,
      value: { ...result, examples },
    });
    return result;
  }
  /** Starts a saved mock again with its examples, on its previous port when free. */
  async restartMock(workspace: string, document: WorkspaceDocument) {
    const saved = (document.value ?? {}) as { port?: number; examples?: MockExample[] };
    const examples = Array.isArray(saved.examples) ? saved.examples : [];
    let result: RunningMock;
    try {
      result = await this.api.execute<RunningMock>('mock.start', {
        workspace,
        port: saved.port ?? 0,
        examples,
      });
    } catch {
      result = await this.api.execute<RunningMock>('mock.start', { workspace, port: 0, examples });
    }
    await this.api.save({ ...document, value: { ...result, examples } });
    return result;
  }
  listMocks(workspace: string) {
    return this.api.execute<RunningMock[]>('mock.list', { workspace });
  }
  stopMock(workspace: string, id: string) {
    return this.api.execute('mock.stop', { workspace, id });
  }
}
