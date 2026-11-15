/**
 * The active cell and the selection of a grid, in positions of what is shown (row and
 * column in sight order), as a spreadsheet: a cell, a range from an anchor, whole rows or
 * whole columns; and the moves of the keyboard.
 */

export interface CellPosition {
  row: number;
  column: number;
}

export interface GridSelection {
  active: CellPosition;
  /** Where a range started; the range goes from it to `active`. */
  anchor: CellPosition;
  /** Whole rows or columns, when chosen by their header. */
  mode: 'cells' | 'rows' | 'columns';
}

export function startSelection(): GridSelection {
  return { active: { row: 0, column: 0 }, anchor: { row: 0, column: 0 }, mode: 'cells' };
}

/** The rectangle a selection covers, in shown positions, inclusive. */
export function selectedRange(selection: GridSelection, rows: number, columns: number) {
  const { active, anchor, mode } = selection;
  const span = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;
  const [top, bottom] = mode === 'columns' ? [0, rows - 1] : span(active.row, anchor.row);
  const [left, right] = mode === 'rows' ? [0, columns - 1] : span(active.column, anchor.column);
  return { top, bottom, left, right };
}

export function isSelected(
  selection: GridSelection,
  rows: number,
  columns: number,
  row: number,
  column: number,
) {
  const range = selectedRange(selection, rows, columns);
  return row >= range.top && row <= range.bottom && column >= range.left && column <= range.right;
}

/** Where a key moves the active cell; `extend` keeps the anchor (Shift). */
export function moveSelection(
  selection: GridSelection,
  key: string,
  options: { rows: number; columns: number; page: number; ctrl: boolean; extend: boolean },
): GridSelection | undefined {
  const { rows, columns, page, ctrl } = options;
  if (!rows || !columns) return undefined;
  let { row, column } = selection.active;
  switch (key) {
    case 'ArrowDown':
      row = ctrl ? rows - 1 : row + 1;
      break;
    case 'ArrowUp':
      row = ctrl ? 0 : row - 1;
      break;
    case 'ArrowRight':
      column = ctrl ? columns - 1 : column + 1;
      break;
    case 'ArrowLeft':
      column = ctrl ? 0 : column - 1;
      break;
    case 'Home':
      column = 0;
      if (ctrl) row = 0;
      break;
    case 'End':
      column = columns - 1;
      if (ctrl) row = rows - 1;
      break;
    case 'PageDown':
      row += page;
      break;
    case 'PageUp':
      row -= page;
      break;
    default:
      return undefined;
  }
  const active = {
    row: Math.min(Math.max(row, 0), rows - 1),
    column: Math.min(Math.max(column, 0), columns - 1),
  };
  return {
    active,
    anchor: options.extend ? selection.anchor : active,
    mode: options.extend ? selection.mode : 'cells',
  };
}

/** The selection after a click on a cell, a row number or a column header. */
export function clickSelection(
  selection: GridSelection,
  target: CellPosition,
  mode: GridSelection['mode'],
  extend: boolean,
): GridSelection {
  return { active: target, anchor: extend ? selection.anchor : target, mode };
}
