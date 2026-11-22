import type { SqlRunner } from '../db-panel/sql-runner';
import type { DbSqlCode } from '../db-sql-code';

/** The selection, or the statement around the cursor (between `;`), without its spaces. */
export function statementRange(
  text: string,
  selection: { from: number; to: number },
): { start: number; end: number } {
  let [from, to] = [selection.from, selection.to];
  if (from === to) {
    from = text.lastIndexOf(';', from - 1) + 1;
    const next = text.indexOf(';', to);
    to = next < 0 ? text.length : next;
  }
  const part = text.slice(from, to);
  return {
    start: from + (part.length - part.trimStart().length),
    end: to - (part.length - part.trimEnd().length),
  };
}

/**
 * Shows the code of the selection or of the statement at the cursor (DB-33), with the values
 * last typed for its parameters; a statement pasted from code replaces the selection.
 */
export async function showCode(code: DbSqlCode, runner: SqlRunner): Promise<void> {
  const text = code.content();
  const selection = code.selection();
  const { start, end } = statementRange(text, selection);
  if (end <= start) {
    runner.results.note({ kind: 'info', text: 'No statement at the cursor' });
    return;
  }
  const cases = await runner.section.cases();
  runner.code.set({
    query: {
      engine: runner.driver(),
      sql: text.slice(start, end),
      values: cases.assist.parameters(),
    },
    paste: (sql) => code.replaceRange(selection.from, selection.to, sql),
  });
}
