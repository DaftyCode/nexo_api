import { SplitStatement } from '../../domain/db/sql';

/** Where an error is: an offset of the editor and its line and column, from 1. */
export function errorPlace(
  script: string,
  base: number,
  statement: SplitStatement,
  detail: unknown,
) {
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
