import { WritableSignal, signal } from '@angular/core';
import { CopyFormat } from '../../domain/db/grid/copy';
import { GridSelection } from '../../domain/db/grid/selection';
import { PopupPlace, placeAt, placeBy } from '../popup-place';
import { GridColumns } from './columns';
import { GridFind } from './find';
import type { GridMenuMode } from './grid-menu';
import type { PanelKind } from './grid-panels';
import { GridLayout } from './layout';

/** What the entries of the grid's menus act on. */
export interface MenuTarget {
  columns: GridColumns;
  layout: GridLayout;
  selection: WritableSignal<GridSelection>;
  /** The active cell: its row among those loaded, its column, its value. */
  active(): { row: number; column: number; value: unknown } | undefined;
  hidden(): readonly number[];
  panel: WritableSignal<PanelKind>;
  recordView: WritableSignal<boolean>;
  textView: WritableSignal<boolean>;
  find: GridFind;
  copy(format: CopyFormat): void;
  download(format: 'csv' | 'json'): void;
  /** An action the screen around the grid offers, such as a quick filter. */
  cellAction(action: string, column: number, value: unknown): void;
  /** Gives the keyboard back to the grid. */
  focus(): void;
}

const PANELS: Record<string, PanelKind> = {
  'tool:value': 'value',
  'tool:meta': 'meta',
  'tool:calc': 'calc',
  'tool:group': 'group',
};

/** Runs the entry of a menu of the grid that was chosen. */
export function runMenuChoice(target: MenuTarget, choice: string) {
  const active = target.active();
  if (choice.startsWith('copy:')) return target.copy(choice.slice(5) as CopyFormat);
  if (choice.startsWith('download:')) return target.download(choice.slice(9) as 'csv' | 'json');
  if (choice.startsWith('toggle:')) {
    const column = Number(choice.slice(7));
    if (target.hidden().includes(column)) return target.columns.show(column);
    return target.columns.hide(column);
  }
  if (choice === 'value') return target.panel.set('value');
  if (PANELS[choice])
    return target.panel.update((kind) => (kind === PANELS[choice] ? 'none' : PANELS[choice]));
  if (choice === 'tool:find') return target.find.open.set(true);
  if (choice === 'tool:record') return target.recordView.update((shown) => !shown);
  if (choice === 'tool:text') return target.textView.update((shown) => !shown);
  if (choice === 'show-all') return target.columns.showAll();
  if (!active) return;
  const width = target.layout.widthOf(active.column);
  if (target.columns.run(choice, active.column, target.layout.order(), width)) return;
  target.cellAction(choice, active.column, active.value);
}

/**
 * The menus of a grid: which one is open and where, opened by a header's ▾ or `⋯`, a row's
 * `⋯`, a right click or the menu key; and what their entries do.
 */
export class GridMenus {
  readonly open = signal<({ mode: GridMenuMode } & PopupPlace) | undefined>(undefined);

  constructor(private readonly target: MenuTarget) {}

  /** Opens a menu by what was clicked; a column's menu makes that column the active one. */
  by(event: MouseEvent, mode: GridMenuMode, column?: number) {
    event.stopPropagation();
    const { selection, layout } = this.target;
    if (column !== undefined) {
      const active = { row: selection().active.row, column: layout.order().indexOf(column) };
      selection.set({ active, anchor: active, mode: 'cells' });
    }
    this.open.set({ mode, ...placeBy(event.currentTarget as HTMLElement) });
  }
  /** The `⋯` of a row: the row is chosen whole and its menu opens. */
  row(event: MouseEvent, position: number) {
    const column = this.target.selection().active.column;
    this.target.selection.set({
      active: { row: position, column },
      anchor: { row: position, column: 0 },
      mode: 'rows',
    });
    this.by(event, 'cell');
  }
  /** The menu of a cell, at the mouse or under the cell. */
  at(x: number, y: number) {
    this.open.set({ mode: 'cell', ...placeAt(x, y) });
  }
  under(element: Element | undefined) {
    this.open.set({ mode: 'cell', ...(element ? placeBy(element) : placeAt(0, 0)) });
  }

  chosen(choice: string) {
    this.close();
    runMenuChoice(this.target, choice);
  }
  close() {
    this.open.set(undefined);
    this.target.focus();
  }
}
