import { ExecutionPort } from '../ports';

/** A request of the API of Elasticsearch or OpenSearch (DB-36). */
export interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

/** What the node answered. */
export interface RestAnswer {
  status: number;
  contentType?: string | null;
  body: unknown;
  elapsedMs: number;
}

/**
 * The API of Elasticsearch and OpenSearch on a session opened with `statements.open`: a
 * request to a path of the node. The application applies the rules of the connection, and
 * the driver refuses any path that leaves the node.
 */
export class DatabaseRestCases {
  constructor(private readonly api: ExecutionPort) {}

  request(
    workspace: string,
    session: string,
    call: RestCall,
    confirmation: { confirm?: boolean; confirmName?: string } = {},
  ) {
    return this.api.execute<RestAnswer>('db.rest.request', {
      workspace,
      session,
      method: call.method,
      path: call.path,
      ...(call.body === undefined ? {} : { body: call.body }),
      ...(confirmation.confirm ? { confirm: true } : {}),
      ...(confirmation.confirmName ? { confirmName: confirmation.confirmName } : {}),
    });
  }
}
