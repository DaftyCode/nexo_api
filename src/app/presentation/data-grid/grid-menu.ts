import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
} from '@angular/core';
import { menuKeys } from '../menu-keys';
import type { CellAction } from './types';

/**
 * Which menu of the grid is open: a column's (its header's ▾), a cell's and its row's (the
 * row's `⋯`, a right click or the menu key), the grid's tools (the header's `⋯`), export,
 * the columns shown, or the quick filters of the active cell.
 */
export type GridMenuMode = 'column' | 'cell' | 'tools' | 'export' | 'columns' | 'filter';

/** The entries for a column, in the order DBeaver lists them. */
const COLUMN = [
  ['ascending', 'Sort ascending'],
  ['descending', 'Sort descending'],
  ['unsorted', 'Remove the order'],
  ['fit', 'Fit to content'],
  ['wider', 'Wider'],
  ['narrower', 'Narrower'],
  ['left', 'Move left'],
  ['right', 'Move right'],
  ['hide', 'Hide the column'],
  ['show-all', 'Show every column'],
] as const;
const ROW = [
  ['tool:record', 'Show the record'],
  ['value', 'Show the value'],
  ['copy:text', 'Copy'],
  ['copy:text-headers', 'Copy with headers'],
  ['copy:json', 'Copy as JSON'],
  ['copy:insert', 'Copy as INSERT'],
  ['copy:update', 'Copy as UPDATE'],
  ['copy:delete', 'Copy as DELETE'],
] as const;
const TOOLS = [
  ['tool:find', 'Find'],
  ['tool:record', 'Record'],
  ['tool:text', 'Text view'],
  ['tool:value', 'db.panel.value'],
  ['tool:meta', 'db.panel.meta'],
  ['tool:calc', 'db.panel.calc'],
  ['tool:group', 'db.panel.group'],
] as const;
const COPY = [
  ['copy:text', 'Text'],
  ['copy:text-headers', 'Text with headers'],
  ['copy:json', 'JSON'],
  ['copy:csv', 'CSV'],
  ['copy:markdown', 'Markdown'],
  ['copy:in', 'IN (…)'],
  ['copy:insert', 'INSERT'],
  ['copy:update', 'UPDATE'],
  ['copy:delete', 'DELETE'],
] as const;
const DOWNLOAD = [
  ['download:csv', 'CSV'],
  ['download:json', 'JSON'],
] as const;

/** The menus of the grid, at the point they were opened from. A WAI-ARIA menu. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-grid-menu',
  template: `
    <div
      class="popup-menu"
      role="menu"
      tabindex="-1"
      [attr.aria-label]="label() | transloco: { v0: column() }"
      [style.left.px]="x()"
      [style.top.px]="bottom() === undefined ? y() : null"
      [style.bottom.px]="bottom()"
      (keydown)="key($event)"
      (click)="$event.stopPropagation()"
    >
      @switch (mode()) {
        @case ('tools') {
          @for (entry of tools; track entry[0]) {
            <button type="button" role="menuitem" (click)="chosen.emit(entry[0])">
              {{ entry[1] | transloco }}
            </button>
          }
        }
        @case ('export') {
          <h4>{{ 'Copy the selection as' | transloco }}</h4>
          @for (entry of copy; track entry[0]) {
            <button type="button" role="menuitem" (click)="chosen.emit(entry[0])">
              {{ entry[1] | transloco }}
            </button>
          }
          <h4>{{ 'Download the rows as' | transloco }}</h4>
          @for (entry of download; track entry[0]) {
            <button type="button" role="menuitem" (click)="chosen.emit(entry[0])">
              {{ entry[1] }}
            </button>
          }
        }
        @case ('columns') {
          @for (name of names(); track $index) {
            <button
              type="button"
              role="menuitemcheckbox"
              [attr.aria-checked]="!hidden().includes($index)"
              (click)="chosen.emit('toggle:' + $index)"
            >
              {{ name }}
            </button>
          }
          <hr />
          <button type="button" role="menuitem" (click)="chosen.emit('show-all')">
            {{ 'Show every column' | transloco }}
          </button>
        }
        @case ('filter') {
          @for (action of actions(); track action.id) {
            <button type="button" role="menuitem" (click)="chosen.emit(action.id)">
              {{ action.label | transloco }}
            </button>
          }
        }
        @default {
          @if (mode() === 'cell') {
            <h4>{{ 'Row' | transloco }}</h4>
            @for (entry of row; track entry[0]) {
              <button type="button" role="menuitem" (click)="chosen.emit(entry[0])">
                {{ entry[1] | transloco }}
              </button>
            }
            @if (actions().length) {
              <h4>{{ 'Filter' | transloco }}</h4>
              @for (action of actions(); track action.id) {
                <button type="button" role="menuitem" (click)="chosen.emit(action.id)">
                  {{ action.label | transloco }}
                </button>
              }
            }
            <h4>{{ 'Column' | transloco }}</h4>
          }
          @for (entry of columnEntries; track entry[0]) {
            <button type="button" role="menuitem" (click)="chosen.emit(entry[0])">
              {{ entry[1] | transloco }}
            </button>
          }
          <button type="button" role="menuitem" (click)="chosen.emit('pin')">
            {{ (pinned() ? 'Unpin the column' : 'Pin the column') | transloco }}
          </button>
          @if (mode() === 'cell') {
            <h4>{{ 'View' | transloco }}</h4>
            @for (entry of tools; track entry[0]) {
              <button type="button" role="menuitem" (click)="chosen.emit(entry[0])">
                {{ entry[1] | transloco }}
              </button>
            }
          }
        }
      }
    </div>
  `,
})
export class GridMenu {
  readonly mode = input<GridMenuMode>('column');
  readonly x = input(0);
  readonly y = input(0);
  /** Opened over the element: the distance from the window's foot to the menu's bottom. */
  readonly bottom = input<number | undefined>(undefined);
  readonly column = input('');
  readonly pinned = input(false);
  readonly actions = input<readonly CellAction[]>([]);
  /** The names of every column and which are hidden, for the menu of the columns shown. */
  readonly names = input<readonly string[]>([]);
  readonly hidden = input<readonly number[]>([]);
  readonly chosen = output<string>();
  readonly closed = output<void>();
  protected readonly columnEntries = COLUMN;
  protected readonly row = ROW;
  protected readonly tools = TOOLS;
  protected readonly copy = COPY;
  protected readonly download = DOWNLOAD;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterNextRender(() => this.host.querySelector<HTMLElement>('button')?.focus());
  }

  protected label() {
    const labels: Record<GridMenuMode, string> = {
      column: 'db.grid.menu',
      cell: 'db.grid.menu',
      tools: 'Grid tools',
      export: 'Export',
      columns: 'Columns shown',
      filter: 'Filter by this value',
    };
    return labels[this.mode()];
  }

  protected key(event: KeyboardEvent) {
    menuKeys(event, this.host, () => this.closed.emit());
  }
}
