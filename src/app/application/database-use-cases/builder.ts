import type { SplitAnswer, SplitStatement } from '../../domain/db/sql';
import { ParsedQuery, readParsedQuery } from '../../domain/db/query-model';
import type { DatabasePorts } from './connections';

/**
 * The visual query builder (DB-26): the statement at the cursor of a script, and its model as
 * the engine reads it, or what it has that the model cannot hold. Nothing runs here.
 */
export class DatabaseBuilderCases {
  constructor(private readonly api: Pick<DatabasePorts, 'execute'>) {}

  /** The statement at `offset` of a script; none where the script has none. */
  async statementAt(
    workspace: string,
    script: string,
    dialect: string,
    offset: number,
  ): Promise<SplitStatement | undefined> {
    const answer = await this.api.execute<SplitAnswer>('db.split', {
      workspace,
      script,
      dialect,
      offset,
    });
    return answer.current === null || answer.current === undefined
      ? undefined
      : answer.statements[answer.current];
  }

  async parse(workspace: string, sql: string, dialect: string): Promise<ParsedQuery> {
    const answer = await this.api.execute<unknown>('db.query.parse', { workspace, sql, dialect });
    return readParsedQuery(answer);
  }
}
