import { ExecutionResponse, Run, WorkspaceDocument } from '../../domain/models';
import { ResponseComparison, comparedSide } from '../../domain/response-compare';
import { ApiPort } from '../ports';

/**
 * Comparing two responses: the backend says what changed (status, headers and body, field
 * by field when both are JSON), leaving out the paths and headers named.
 */
export class CompareCases {
  constructor(private readonly api: ApiPort) {}

  compare(
    workspace: string,
    source: ExecutionResponse,
    target: ExecutionResponse,
    ignore: readonly string[] = [],
    ignoreHeaders: readonly string[] = [],
  ): Promise<ResponseComparison> {
    return this.api.execute<ResponseComparison>('response.compare', {
      workspace,
      source: comparedSide(source),
      target: comparedSide(target),
      ...(ignore.length ? { ignore } : {}),
      ...(ignoreHeaders.length ? { ignoreHeaders } : {}),
    });
  }

  /** The response a history entry keeps. */
  async historyResponse(document: WorkspaceDocument): Promise<ExecutionResponse> {
    const value = await this.value(document);
    const response = (value as { response?: ExecutionResponse } | undefined)?.response;
    if (!response) throw new Error('This history entry has no response');
    return response;
  }

  /** A collection run kept in the workspace, with its responses. */
  async run(document: WorkspaceDocument): Promise<Run> {
    const value = (await this.value(document)) as Partial<Run> | undefined;
    return {
      id: document.id,
      state: '',
      assertions: [],
      logs: [],
      ...value,
      results: value?.results ?? [],
    };
  }

  /** History entries and runs are listed without their values: they are read when chosen. */
  private async value(document: WorkspaceDocument) {
    return document.value === null || document.value === undefined
      ? (await this.api.document(document.id)).value
      : document.value;
  }
}
