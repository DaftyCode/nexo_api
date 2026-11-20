import { ExecutionResponse, WorkspaceDocument } from '../../domain/models';
import { SCHEMA_SAMPLES, schemaSamples } from '../../domain/schema-test';
import { ApiPort } from '../ports';

/** A JSON Schema read from responses, with how many there were. */
export interface InferredSchema {
  schema: Record<string, unknown>;
  sampled: number;
}

/**
 * The JSON Schema of the responses of a request: the backend reads it from the response
 * shown and those the history keeps of the same request.
 */
export class SchemaCases {
  constructor(
    private readonly api: ApiPort,
    /** The response a history entry keeps. */
    private readonly historyResponse: (document: WorkspaceDocument) => Promise<ExecutionResponse>,
  ) {}

  /**
   * Infers the schema from `shown` and the entries of `history` named `name`, newest first.
   * Entries whose response cannot be read are left out.
   */
  async infer(
    workspace: string,
    shown: ExecutionResponse,
    history: readonly WorkspaceDocument[],
    name: string,
    enums: boolean,
  ): Promise<InferredSchema> {
    const entries = history
      .filter((entry) => entry.name === name)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, SCHEMA_SAMPLES);
    const others = await Promise.all(
      entries.map((entry) => this.historyResponse(entry).catch(() => undefined)),
    );
    const samples = schemaSamples(
      shown,
      others.filter((response): response is ExecutionResponse => !!response),
    );
    if (!samples.length) throw new Error('This response is not complete JSON');
    return this.api.execute<InferredSchema>('schema.infer', {
      workspace,
      samples,
      ...(enums ? { enums } : {}),
    });
  }
}
