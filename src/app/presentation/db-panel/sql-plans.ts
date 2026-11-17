import { PlanMode } from '../../domain/db/plan';
import { ResultTab } from '../../domain/db/results';
import { withVariables } from '../../domain/db/sql';
import type { SqlRunner } from './sql-runner';

/**
 * The plans of a SQL tab's statements (DB-16), as DBeaver's «Explain execution plan»
 * (Ctrl+Shift+E): on the tab's session, with its variables and parameters, each plan in a
 * result tab of its own. The actual plan of a change asks first: it runs, and is rolled back.
 */
export class SqlPlans {
  constructor(private readonly runner: SqlRunner) {}

  private async split(text: string, cursor?: number) {
    try {
      const cases = await this.runner.section.cases();
      const workspace = this.runner.section.state.workspaceId();
      return await cases.statements.split(workspace, text, this.runner.driver(), cursor);
    } catch (error) {
      this.note('error', this.runner.section.state.describe(error));
      return undefined;
    }
  }

  private note(kind: 'info' | 'error', text: string, params?: Record<string, string>) {
    this.runner.results.note({ kind, text, ...(params ? { params } : {}) });
  }

  /** Explains the selection, or the statement at the cursor. */
  async explainAt(
    script: string,
    cursor: number,
    selected: { text: string },
    mode: PlanMode = 'estimated',
  ) {
    const chosen = selected.text.trim();
    const split = await this.split(chosen ? selected.text : script, chosen ? undefined : cursor);
    if (!split) return;
    const statement = chosen ? split.statements[0] : split.statements[split.current ?? -1];
    if (!statement) return this.note('info', 'Nothing to explain at the cursor');
    await this.explain(statement.text, mode, statement.classification.kind === 'write');
  }

  /**
   * The plan of a result tab's statement: in a tab of its own for a result's rows, again in
   * the same tab for a plan (in the mode asked).
   */
  async again(tab: ResultTab, mode: PlanMode = 'estimated') {
    const split = await this.split(tab.sql);
    if (!split) return;
    const writes = split.statements.some((statement) => statement.classification.kind === 'write');
    await this.explain(tab.sql, mode, writes, tab.plan ? tab : undefined);
  }

  private confirm(): Promise<boolean> {
    return new Promise((done) =>
      this.runner.dialog.set({
        kind: 'confirm',
        confirmation: { message: 'db.plan.confirmActual' },
        sql: '',
        answer: (ok) => {
          this.runner.dialog.set(undefined);
          done(ok);
        },
      }),
    );
  }

  private async explain(text: string, mode: PlanMode, writes: boolean, into?: ResultTab) {
    const { runner } = this;
    const { section } = runner;
    let sql: string;
    try {
      sql = runner.client.withVariables(withVariables(text, section.state.scopes()));
    } catch (error) {
      return this.note('error', section.state.describe(error));
    }
    const actualChange = mode === 'actual' && writes;
    if (actualChange && !(await this.confirm()))
      return this.note('info', 'Not explained: it was not confirmed');
    if (!(await runner.open())) return;
    const bound = await runner.client.bind(sql, runner.parameterStyle());
    if (!bound) return this.note('info', 'Not run: its parameters were not given');
    const cases = await section.cases();
    const run = `${runner.tab}-plan-${Date.now()}`;
    runner.running.set(run);
    const started = Date.now();
    try {
      const plan = await cases.plans.explain(
        section.state.workspaceId(),
        runner.session,
        run,
        bound.sql,
        { mode, params: bound.params, confirm: actualChange },
      );
      const orders = runner.results.tabs().map((tab) => tab.order);
      const tab: ResultTab = {
        id: into?.id ?? section.state.cases.files.id(),
        order: into?.order ?? Math.max(0, ...orders) + 1,
        sql,
        pinned: into?.pinned ?? false,
        columns: [],
        rows: [],
        startedAt: started,
        executeMs: Date.now() - started,
        fetchMs: 0,
        plan,
      };
      if (into) runner.results.replace(into.id, tab);
      else runner.results.add(tab, false);
      if (plan.rolledBack) this.note('info', 'db.plan.rolledBack');
    } catch (error) {
      this.note('error', section.state.describe(error));
    } finally {
      runner.running.set('');
    }
  }
}
