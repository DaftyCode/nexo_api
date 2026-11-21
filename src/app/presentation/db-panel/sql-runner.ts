import { signal } from '@angular/core';
import { ApiFailure } from '../../application/ports';
import { connectionType, readDbConnection } from '../../domain/db/connection';
import { Group } from '../../domain/db/grid/calc';
import { FurtherResult, ResultTab, cellText } from '../../domain/db/results';
import {
  Confirmation,
  SplitStatement,
  confirmationOf,
  groupQuery,
  withVariables,
} from '../../domain/db/sql';
import { PAGE_ROWS } from './sql-results';
import { SqlSession } from './sql-session';
import { ScriptClient } from './sql-client';
import { prepareTransaction } from './sql-transaction';
import { errorPlace } from './error-place';

/** What the tab asks the person before a statement runs or after one fails. */
export type RunnerDialog =
  | { kind: 'confirm'; confirmation: Confirmation; sql: string; answer: (ok: boolean) => void }
  | {
      kind: 'failure';
      message: string;
      answer: (choice: 'continue' | 'stop' | 'ignore', remember: boolean) => void;
    };

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
  /** The `@` commands, `${variables}` and parameters of its scripts (DB-15). */
  readonly client = new ScriptClient(this);
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
    const parts = this.client.parts(text);
    if (!parts) return;
    this.ignoreFailures = false;
    for (const part of parts) {
      if (part.kind === 'command') {
        if (!(await this.client.command(part.command))) return;
        continue;
      }
      const split = await this.split(part.text);
      for (const statement of split?.statements ?? []) {
        if (this.client.exportNext(statement.text)) continue;
        const many = parts.length > 1 || (split?.statements.length ?? 0) > 1;
        const ran = await this.runStatement(statement, base + part.offset, script, fresh || many);
        if (ran === 'cancelled') return;
        if (ran === 'failed' && !(await this.goOn())) return;
      }
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
      sql = this.client.withVariables(withVariables(statement.text, this.section.state.scopes()));
    } catch (error) {
      const params = (error as { params?: Record<string, string> }).params;
      const text = this.section.state.describe(error);
      this.results.note({ kind: 'error', text, ...(params ? { params } : {}) });
      return 'failed';
    }
    const production = connectionType(readDbConnection(this.connection()?.value)) === 'production';
    const confirmation = confirmationOf(statement.classification, production);
    if (confirmation && !(await this.confirm(confirmation, sql))) {
      this.results.note({ kind: 'info', text: 'Not run: it was not confirmed' });
      return 'cancelled';
    }
    if (!(await this.open())) return 'failed';
    const bound = await this.client.bind(sql, this.parameterStyle());
    if (!bound) {
      this.results.note({ kind: 'info', text: 'Not run: its parameters were not given' });
      return 'cancelled';
    }
    const asked = (wanted: Confirmation) => this.confirm(wanted, sql);
    if (!(await prepareTransaction(this, statement.classification, asked))) return 'cancelled';
    const cases = await this.section.cases();
    const run = `${this.tab}-${++this.runs}`;
    this.running.set(run);
    const started = Date.now();
    try {
      const answer = await cases.statements.execute(
        this.workspace(),
        this.session,
        run,
        bound.sql,
        {
          pageRows: PAGE_ROWS,
          ...(bound.params.length ? { params: bound.params } : {}),
          ...(confirmation ? { confirm: true } : {}),
          ...(confirmation?.names ? { confirmName: confirmation.names } : {}),
        },
      );
      if (answer.reconnected)
        this.results.note({ kind: 'warning', text: reconnected(answer.transactionLost) });
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
        this.addFurther(answer.results ?? [], sql, started, answer.elapsedMs, tab.id);
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

  /** A tab for each further result of a batch (SQL Server), the first one still shown. */
  private addFurther(
    further: readonly FurtherResult[],
    sql: string,
    started: number,
    executeMs: number,
    first: string,
  ) {
    for (const [index, set] of further.entries()) {
      const tab: ResultTab = {
        id: this.section.state.cases.files.id(),
        order: ++this.order,
        sql,
        pinned: false,
        columns: set.columns,
        rows: set.rows,
        startedAt: started,
        executeMs,
        fetchMs: 0,
      };
      this.results.add(tab, false);
      if (set.truncated)
        this.results.note({
          kind: 'warning',
          text: 'db.resultCut',
          params: { v0: String(index + 2), v1: String(set.rows.length) },
        });
    }
    if (further.length) this.results.active.set(first);
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

  /** Groups the rows of a whole table on the server, for the Grouping panel. */
  async group(table: string, columns: readonly string[]): Promise<Group[]> {
    if (!(await this.open())) return [];
    const cases = await this.section.cases();
    const sql = groupQuery(table, columns, this.section.sqlStyle(this.connection()?.id ?? ''));
    const run = `${this.tab}-group-${Date.now()}`;
    const answer = await cases.statements.execute(this.workspace(), this.session, run, sql, {
      pageRows: 500,
    });
    if (answer.cursor)
      await cases.statements.closeCursor(this.workspace(), this.session, answer.cursor);
    return answer.rows.map((row) => ({
      values: row.slice(0, -1).map(cellText),
      count: Number(cellText(row.at(-1))),
    }));
  }
}

/** What a statement that ran on a connection opened again says first. */
export const reconnected = (lost?: boolean) =>
  lost
    ? 'The connection had closed and was opened again; its open transaction was lost.'
    : 'The connection had closed and was opened again.';
