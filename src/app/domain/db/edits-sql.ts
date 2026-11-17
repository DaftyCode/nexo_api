/**
 * Edited values as the engine takes them, and the script a save would run, written with its
 * values in line to be read (the save itself binds them).
 */
import { ChangedCell, EditTarget, RowChange } from './edits';
import { SqlStyle, sqlLiteral } from './grid/copy';
import { ResultColumn } from './results';
import { quoteName } from './tree';

const SAFE = Number.MAX_SAFE_INTEGER;

/** What was typed in a cell, as a value of its column's class; or why it does not fit. */
export function parseInput(
  text: string,
  column: ResultColumn,
): { value: unknown; error?: undefined } | { error: string } {
  const trimmed = text.trim();
  switch (column.kind) {
    case 'integer': {
      if (!/^[-+]?\d+$/.test(trimmed)) return { error: 'db.edit.notInteger' };
      const number = Number(trimmed);
      return { value: Math.abs(number) <= SAFE ? number : { $t: 'integer', v: trimmed } };
    }
    case 'float': {
      const number = Number(trimmed);
      return trimmed && Number.isFinite(number)
        ? { value: number }
        : { error: 'db.edit.notNumber' };
    }
    case 'decimal':
      return /^[-+]?\d+(\.\d+)?$/.test(trimmed)
        ? { value: { $t: 'decimal', v: trimmed } }
        : { error: 'db.edit.notNumber' };
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (['true', '1', 'yes', 't'].includes(lower)) return { value: true };
      if (['false', '0', 'no', 'f'].includes(lower)) return { value: false };
      return { error: 'db.edit.notBoolean' };
    }
    case 'json':
      try {
        JSON.parse(text);
        return { value: { $t: 'json', v: text } };
      } catch {
        return { error: 'db.edit.notJson' };
      }
    case 'binary':
      return { error: 'db.edit.binary' };
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestamptz':
    case 'interval':
    case 'uuid':
    case 'xml':
      return { value: { $t: column.kind, v: trimmed } };
    default:
      return { value: text };
  }
}

/** The rows and columns of text pasted from a spreadsheet: tabs and lines. */
export function tsvBlock(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map((line) => line.split('\t'));
}

/** The statements of a save, with their values in line, to read before saving. */
export function editScript(target: EditTarget, changes: readonly RowChange[], style: SqlStyle) {
  const name = (column: string) => quoteName(column, style);
  const table = [target.schema, target.table]
    .filter((part): part is string => !!part)
    .map(name)
    .join('.');
  const literal = (cell: ChangedCell) => (cell.default ? 'DEFAULT' : sqlLiteral(cell.value, style));
  const where = (cells: readonly ChangedCell[]) =>
    cells
      .map((cell) =>
        cell.value === null && !cell.default
          ? `${name(cell.column)} IS NULL`
          : `${name(cell.column)} = ${literal(cell)}`,
      )
      .join(' AND ');
  return changes
    .map((change) => {
      if (change.kind === 'update')
        return `UPDATE ${table} SET ${change.values
          .map((cell) => `${name(cell.column)} = ${literal(cell)}`)
          .join(', ')} WHERE ${where(change.key)};`;
      if (change.kind === 'delete') return `DELETE FROM ${table} WHERE ${where(change.key)};`;
      const given = change.values.filter((cell) => !cell.default);
      return given.length
        ? `INSERT INTO ${table} (${given.map((cell) => name(cell.column)).join(', ')}) VALUES (${given
            .map(literal)
            .join(', ')});`
        : `INSERT INTO ${table} DEFAULT VALUES;`;
    })
    .join('\n');
}
