import { WorkspaceDocument } from '../../domain/models';
import { DbNode, QuoteStyle } from '../../domain/db/tree';
import { VariableScopes } from '../../domain/variables';
import { ExecutionPort } from '../ports';
import { connectionVariables } from './connections';

/** What a driver says about itself (`db.dialect`). */
export interface DriverHello {
  driver: { id: string; name: string; version: string };
  capabilities: {
    transactions: boolean;
    schemas: boolean;
    cancel: boolean;
    readOnlySessions: boolean;
  };
  dialect: QuoteStyle & {
    name: string;
    parameters: string;
    functions: string[];
    types: string[];
  };
}

/** What a server says once connected. */
export interface DbServerInfo {
  serverVersion: string;
  product?: string;
  database?: string;
  user?: string;
  tls: boolean;
}

/** The session of the navigator of a connection; editors open their own (DB-14). */
export const treeSession = (connection: string) => `tree:${connection}`;

/**
 * The navigator: a session per connection opened when it is expanded, and its tree asked
 * node by node.
 */
export class DatabaseNavigatorCases {
  private readonly hellos = new Map<string, Promise<DriverHello>>();

  constructor(private readonly api: ExecutionPort) {}

  connect(
    workspace: string,
    connection: WorkspaceDocument,
    session: string,
    scopes: VariableScopes,
  ): Promise<DbServerInfo> {
    return this.api.execute<DbServerInfo>('db.connect', {
      workspace,
      connectionId: connection.id,
      session,
      variables: connectionVariables(connection.value, scopes),
    });
  }

  disconnect(workspace: string, session: string): Promise<void> {
    return this.api.execute<void>('db.disconnect', { workspace, session });
  }

  async tree(workspace: string, session: string, path: readonly string[]): Promise<DbNode[]> {
    const answer = await this.api.execute<{ nodes: DbNode[] }>('db.tree', {
      workspace,
      session,
      path,
    });
    return answer.nodes;
  }

  async ddl(workspace: string, session: string, path: readonly string[]): Promise<string> {
    const answer = await this.api.execute<{ sql: string }>('db.ddl', { workspace, session, path });
    return answer.sql;
  }

  /** What the driver of a module says about itself; asked once per driver. */
  hello(workspace: string, driver: string): Promise<DriverHello> {
    let known = this.hellos.get(driver);
    if (!known) {
      known = this.api.execute<DriverHello>('db.dialect', { workspace, driver });
      known.catch(() => this.hellos.delete(driver));
      this.hellos.set(driver, known);
    }
    return known;
  }
}
