import { WritableSignal } from '@angular/core';
import { GridSelection, clickSelection } from '../../domain/db/grid/selection';
import { GridCellEditor } from './cell-editor';
import { GridFind } from './find';
import type { PanelKind } from './grid-panels';
import { gridKey } from './keys';
import { GridLayout } from './layout';
import { GridMenus } from './menu-actions';
import { GridOutput } from './output';

/** What the pointer and the keys of a grid act on. */
export interface InteractionContext {
  layout: GridLayout;
  selection: WritableSignal<GridSelection>;
  panel: WritableSignal<PanelKind>;
  find: GridFind;
  output: GridOutput;
  menus: GridMenus;
  editor: GridCellEditor;
  viewport: () => HTMLElement | undefined;
}

/**
 * The pointer and the keys of a grid: a click chooses a cell or a row, a double click edits
 * the cell (or shows its value when nothing can be edited), the keys move, select, find and
 * open menus, and the record view and the finder move the active cell.
 */
export class GridInteraction {
  constructor(private readonly context: InteractionContext) {}

  scrolled() {
    const element = this.context.viewport();
    if (element) this.context.layout.read(element);
  }
  reveal() {
    const element = this.context.viewport();
    if (element) this.context.layout.reveal(element, this.context.selection().active);
  }

  key(event: KeyboardEvent) {
    const { editor, layout, selection, panel, find, output, menus, viewport } = this.context;
    if (editor.key(event)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && editor.enabled()) {
      event.preventDefault();
      return void editor.paste();
    }
    gridKey(event, {
      layout,
      selection,
      panel,
      findOpen: find.open,
      copy: (keys) => output.copy(keys, 'text'),
      menu: () => menus.under(viewport()?.querySelector('.grid-active') ?? viewport()),
      reveal: () => this.reveal(),
    });
  }

  findNext(back = false) {
    const target = this.context.find.next(this.context.selection().active, back);
    if (!target) return;
    this.context.selection.set({ active: target, anchor: target, mode: 'cells' });
    this.reveal();
  }

  /** The record view goes to the row before or after. */
  step(by: -1 | 1) {
    const last = this.context.layout.shown().length - 1;
    const row = Math.min(Math.max(this.context.selection().active.row + by, 0), last);
    const active = { row, column: this.context.selection().active.column };
    this.context.selection.set({ active, anchor: active, mode: 'cells' });
  }

  /** A click on a cell or a row number: the grid takes it, as it holds the keyboard. */
  clicked(event: MouseEvent) {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!target) return;
    const mode = target.dataset['mode'] === 'rows' ? 'rows' : 'cells';
    const at = {
      row: Number(target.dataset['row']),
      column: Number(target.dataset['column'] ?? 0),
    };
    const { selection } = this.context;
    selection.set(clickSelection(selection(), at, mode, event.shiftKey));
    this.context.viewport()?.focus({ preventScroll: true });
  }
  doubleClicked(event: MouseEvent) {
    if ((event.target as HTMLElement).closest('.grid-editor')) return;
    if (this.context.editor.enabled()) this.context.editor.start();
    else this.context.panel.set('value');
  }
  contextMenu(event: MouseEvent) {
    if (!(event.target as HTMLElement).closest('[data-column]')) return;
    event.preventDefault();
    this.clicked(event);
    this.context.menus.at(event.clientX, event.clientY);
  }
}
