import { signal } from '@angular/core';
import { ApiFailure } from '../../application/ports';
import { connectionType, readDbConnection } from '../../domain/db/connection';
import { ResultTab } from '../../domain/db/results';
import { Confirmation, SplitStatement, confirmationOf, withVariables } from '../../domain/db/sql';
import { PAGE_ROWS } from './sql-results';
import { SqlSession } from './sql-session';

/** What the tab asks the person before a statement runs or after one fails. */
export type RunnerDialog =
  | { kind: 'confirm'; confirmation: Confirmation; sql: string; answer: (ok: boolean) => void }
  | {
      kind: 'failure';
      message: string;
      answer: (choice: 'continue' | 'stop' | 'ignore', remember: boolean) => void;
    };

/** Where an error is: an offset of the editor and its line and column, from 1. */
function errorPlace(script: string, base: number, statement: SplitStatement, detail: unknown) {
  const place = (detail ?? {}) as { line?: unknown; column?: unknown };
  if (typeof place.line !== 'number') return undefined;
  const lines = statement.text.split('\n');
  const line = Math.min(Math.max(place.line, 1), lines.length);
  const column = typeof place.column === 'number' ? Math.max(place.column, 1) : 1;
  const inside =
    lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
  const offset = base + statement.start + inside;
  const before = script.slice(0, offset);
  return {
    offset,
    line: before.split('\n').length,
    column: offset - before.lastIndexOf('\n'),
  };
}

/**
 * A SQL tab while it is open: what runs on its session, confirmed first when it needs it,
 * and its results and messages. It lives as long as its tab, so switching tabs keeps all.
 */
export class SqlRunner extends SqlSession {
  readonly dialog = signal<RunnerDialog | undefined>(undefined);
  /** Run into the last result tab that is not pinned, instead of opening another. */
  readonly reuse = signal(false);
  /** The editor's place of the last error, for the tab to go there. */
  readonly errorAt = signal<{ offset: number } | undefined>(undefined);
  private runs = 0;
  private order = 0;
  private ignoreFailures = false;

  /**
   * Runs the statement at the cursor or, with text selected, the statements of the
   * selection. `fresh` opens a result tab even when results are reused.
   */
  async runAt(
    script: string,
    cursor: number,
    selected: { from: number; text: string },
    fresh = false,
  ) {
    if (selected.text.trim()) return this.runScript(selected.text, selected.from, script, fresh);
    const split = await this.split(script, cursor);
    const statement = split?.statements[split.current ?? -1];
    if (!statement)
      return this.results.note({ kind: 'info', text: 'Nothing to run at the cursor' });
    await this.runStatement(statement, 0, script, fresh);
  }

  /** Runs every statement of `text` (the script, or a selection at `base`) in order. */
  async runScript(text: string, base = 0, script = text, fresh = false) {
    const split = await this.split(text);
    if (!split?.statements.length) return;
    this.ignoreFailures = false;
    for (const statement of split.statements) {
      const ran = await this.runStatement(
        statement,
        base,
        script,
        fresh || split.statements.length > 1,
      );
      if (ran === 'cancelled') return;
      if (ran === 'failed' && !(await this.goOn())) return;
    }
  }

  /** Whether a script goes on after a failure, as the person chooses or chose for good. */
  private async goOn(): Promise<boolean> {
    if (this.ignoreFailures) return true;
    const cases = await this.section.cases();
    const stored = cases.statements.onFailure();
    if (stored !== 'ask') return stored === 'continue';
    return new Promise((done) =>
      this.dialog.set({
        kind: 'failure',
        message: 'db.failure.message',
        answer: (choice, remember) => {
          this.dialog.set(undefined);
          if (choice === 'ignore') this.ignoreFailures = true;
          if (remember && choice !== 'ignore') cases.statements.setOnFailure(choice);
          done(choice !== 'stop');
        },
      }),
    );
  }

  private async split(text: string, cursor?: number) {
    try {
      const cases = await this.section.cases();
      return await cases.statements.split(this.workspace(), text, this.driver(), cursor);
    } catch (error) {
      this.results.note({ kind: 'error', text: this.section.state.describe(error) });
      return undefined;
    }
  }

  private confirm(confirmation: Confirmation, sql: string): Promise<boolean> {
    return new Promise((done) =>
      this.dialog.set({
        kind: 'confirm',
        confirmation,
        sql,
        answer: (ok) => {
          this.dialog.set(undefined);
          done(ok);
        },
      }),
    );
  }

  /** Runs one statement: confirmed first when it needs it; its rows go to a result tab. */
  private async runStatement(
    statement: SplitStatement,
    base: number,
    script: string,
    fresh: boolean,
    into?: ResultTab,
  ): Promise<'ran' | 'failed' | 'cancelled'> {
    let sql: string;
    try {
      sql = withVariables(statement.text, this.section.state.scopes());
    } catch (error) {
      this.results.note({ kind: 'error', text: this.section.state.describe(error) });
      return 'failed';
    }
    const production = connectionType(readDbConnection(this.connection()?.value)) === 'production';
    const confirmation = confirmationOf(statement.classification, production);
    if (confirmation && !(await this.confirm(confirmation, sql))) {
      this.results.note({ kind: 'info', text: 'Not run: it was not confirmed' });
      return 'cancelled';
    }
    if (!(await this.open())) return 'failed';
    const cases = await this.section.cases();
    const run = `${this.tab}-${++this.runs}`;
    this.running.set(run);
    const started = Date.now();
    try {
      const answer = await cases.statements.execute(this.workspace(), this.session, run, sql, {
        pageRows: PAGE_ROWS,
        ...(confirmation ? { confirm: true } : {}),
        ...(confirmation?.names ? { confirmName: confirmation.names } : {}),
      });
      for (const notice of answer.notices ?? [])
        this.results.note({
          kind: notice.severity === 'info' ? 'info' : 'warning',
          text: notice.message,
        });
      const took = Date.now() - started;
      if (answer.columns.length) {
        const tab: ResultTab = {
          id: this.section.state.cases.files.id(),
          order: into?.order ?? ++this.order,
          sql,
          pinned: false,
          columns: answer.columns,
          rows: answer.rows,
          ...(answer.cursor ? { cursor: answer.cursor } : {}),
          startedAt: started,
          executeMs: answer.elapsedMs,
          fetchMs: Math.max(0, took - answer.elapsedMs),
        };
        if (into) this.results.replace(into.id, tab);
        else this.results.add(tab, this.reuse() && !fresh);
      } else
        this.results.note({
          kind: 'info',
          text: typeof answer.affected === 'number' ? 'db.affected' : 'db.ran',
          params: { v0: String(answer.affected ?? 0), v1: String(took) },
        });
      if (this.transaction() && !this.transaction()!.autoCommit) await this.refreshTransaction();
      return 'ran';
    } catch (error) {
      const place = errorPlace(script, base, statement, (error as ApiFailure).detail);
      this.results.note({
        kind: 'error',
        text: this.section.state.describe(error),
        ...(place ? { line: place.line, column: place.column, offset: place.offset } : {}),
      });
      if (place) this.errorAt.set({ offset: place.offset });
      return (error as ApiFailure).code === 'database.cancelled' ? 'cancelled' : 'failed';
    } finally {
      this.running.set('');
    }
  }

  /** Runs a result's statement again into its own tab. */
  async rerun(tab: ResultTab) {
    const statement: SplitStatement = {
      text: tab.sql,
      start: 0,
      end: tab.sql.length,
      line: 1,
      classification: {
        kind: 'read',
        missingWhere: false,
        truncate: false,
        drop: [],
        drops: false,
      },
    };
    await this.runStatement(statement, 0, tab.sql, false, tab);
  }
}
