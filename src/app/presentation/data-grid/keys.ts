import { WritableSignal } from '@angular/core';
import { GridSelection, moveSelection } from '../../domain/db/grid/selection';
import type { PanelKind } from './grid-panels';
import { GridLayout } from './layout';

/** What the keys of a grid act on. */
export interface KeyTarget {
  layout: GridLayout;
  selection: WritableSignal<GridSelection>;
  panel: WritableSignal<PanelKind>;
  findOpen: WritableSignal<boolean>;
  copy(event: Event): void;
  /** Opens the active cell's menu. */
  menu(): void;
  /** Scrolls the active cell into sight. */
  reveal(): void;
  /** The screen opens the active cell itself; true when it did. */
  open?(): boolean;
}

/**
 * The keys of a grid, as DBeaver's: arrows and pages move (with Shift they select), Ctrl+C
 * copies, Ctrl+A selects all, Ctrl+F finds, Enter opens what the screen opens or shows the
 * value, the menu key or Shift+F10
 * opens the cell's menu.
 */
export function gridKey(event: KeyboardEvent, target: KeyTarget) {
  const { layout, selection } = target;
  const ctrl = event.ctrlKey || event.metaKey;
  const letter = event.key.toLowerCase();
  if (ctrl && letter === 'c') return target.copy(event);
  if (ctrl && letter === 'a') {
    event.preventDefault();
    const end = { row: layout.shown().length - 1, column: layout.order().length - 1 };
    return selection.set({ active: end, anchor: { row: 0, column: 0 }, mode: 'cells' });
  }
  if (ctrl && letter === 'f') {
    event.preventDefault();
    return target.findOpen.set(true);
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (target.open?.()) return;
    return target.panel.set('value');
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    return target.menu();
  }
  const moved = moveSelection(selection(), event.key, {
    rows: layout.shown().length,
    columns: layout.order().length,
    page: layout.page(),
    ctrl,
    extend: event.shiftKey,
  });
  if (!moved) return;
  event.preventDefault();
  selection.set(moved);
  target.reveal();
}
