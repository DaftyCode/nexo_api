import { ExplainPlan, PlanMode } from '../../domain/db/plan';
import { ExecutionPort } from '../ports';

/** How a statement is explained. */
export interface ExplainOptions {
  mode: PlanMode;
  params?: readonly unknown[];
  /** The actual plan of a change: it runs, and is rolled back. */
  confirm?: boolean;
}

/**
 * Execution plans (`db.explain`): the estimated one, which runs nothing, and the actual one,
 * which runs the statement to measure it (a change inside a transaction rolled back).
 */
export class DatabasePlanCases {
  constructor(private readonly api: ExecutionPort) {}

  explain(
    workspace: string,
    session: string,
    statement: string,
    sql: string,
    options: ExplainOptions,
  ): Promise<ExplainPlan> {
    return this.api.execute<ExplainPlan>('db.explain', {
      workspace,
      session,
      statement,
      sql,
      mode: options.mode,
      ...(options.params?.length ? { params: options.params } : {}),
      ...(options.confirm ? { confirm: true } : {}),
    });
  }
}
