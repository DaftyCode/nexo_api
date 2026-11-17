import { DdlPlan, TableModel, readTable } from '../../domain/db/structure';
import { ExecutionPort } from '../ports';

/**
 * The structure editor (DB-19): the model of a table and the types of its engine, the
 * statements of a change written by the driver, and those statements run on a session one
 * after another, under the rules of every statement (in a transaction when the engine rolls
 * changes of structure back).
 */
export class DatabaseStructureCases {
  constructor(private readonly api: ExecutionPort) {}

  async model(workspace: string, session: string, path: readonly string[] = []) {
    const answer = await this.api.execute<{ table: unknown; types?: string[] }>('db.ddl.model', {
      workspace,
      session,
      ...(path.length ? { path } : {}),
    });
    return { table: readTable(answer.table), types: answer.types ?? [] };
  }

  plan(
    workspace: string,
    session: string,
    original: TableModel | undefined,
    target: TableModel | undefined,
    cascade = false,
  ): Promise<DdlPlan> {
    return this.api.execute<DdlPlan>('db.ddl.plan', {
      workspace,
      session,
      ...(original ? { original } : {}),
      ...(target ? { target } : {}),
      ...(cascade ? { cascade: true } : {}),
    });
  }

  /**
   * Runs the statements in order: the person read and confirmed them (`confirmName` is the
   * name typed for a `DROP`). Inside a transaction when the engine allows, undone on a failure.
   */
  async run(
    workspace: string,
    session: string,
    statements: readonly string[],
    options: { transactional: boolean; confirmName?: string },
  ): Promise<void> {
    const transaction = (action: 'begin' | 'commit' | 'rollback') =>
      this.api.execute('db.transaction', { workspace, session, action });
    if (options.transactional) await transaction('begin');
    try {
      for (const sql of statements)
        await this.api.execute('db.execute', {
          workspace,
          session,
          statement: `structure-${Date.now()}`,
          sql,
          confirm: true,
          ...(options.confirmName ? { confirmName: options.confirmName } : {}),
        });
    } catch (error) {
      if (options.transactional) await transaction('rollback').catch(() => undefined);
      throw error;
    }
    if (options.transactional) await transaction('commit');
  }
}
