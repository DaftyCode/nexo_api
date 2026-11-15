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
import type { CellAction } from './data-grid';

/** The entries for the column of the active cell, in the order DBeaver lists them. */
const ENTRIES = [
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
  ['value', 'Show the value'],
  ['copy:text-headers', 'Copy with headers'],
  ['copy:insert', 'Copy as INSERT'],
] as const;

/** The menu of the active cell's column: order, width, place, visibility, copy and more. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-grid-menu',
  template: `
    <div
      class="grid-menu"
      role="menu"
      tabindex="-1"
      [attr.aria-label]="'db.grid.menu' | transloco: { v0: column() }"
      (keydown)="key($event)"
    >
      @for (entry of entries; track entry[0]) {
        <button type="button" role="menuitem" (click)="chosen.emit(entry[0])">
          {{ entry[1] | transloco }}
        </button>
      }
      <button type="button" role="menuitem" (click)="chosen.emit('pin')">
        {{ (pinned() ? 'Unpin the column' : 'Pin the column') | transloco }}
      </button>
      @for (action of actions(); track action.id) {
        <button type="button" role="menuitem" (click)="chosen.emit(action.id)">
          {{ action.label | transloco }}
        </button>
      }
    </div>
  `,
  styles: `
    .grid-menu {
      position: absolute;
      top: var(--nexo-space-10);
      right: var(--nexo-space-4);
      z-index: var(--nexo-z-popover);
      display: flex;
      flex-direction: column;
      padding: var(--nexo-space-2);
      border: var(--nexo-border-width) solid var(--nexo-color-border);
      border-radius: var(--nexo-radius-md);
      background: var(--nexo-color-surface);
      box-shadow: var(--nexo-shadow-lg);
    }
    button {
      padding: var(--nexo-space-2) var(--nexo-space-4);
      border-radius: var(--nexo-radius-sm);
      color: var(--nexo-color-text);
      font-size: var(--nexo-font-size-sm);
      text-align: left;
    }
    button:hover,
    button:focus-visible {
      background: var(--nexo-color-hover);
    }
  `,
})
export class GridMenu {
  readonly column = input.required<string>();
  readonly pinned = input(false);
  readonly actions = input<readonly CellAction[]>([]);
  readonly chosen = output<string>();
  readonly closed = output<void>();
  protected readonly entries = ENTRIES;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterNextRender(() => this.host.querySelector<HTMLElement>('button')?.focus());
  }

  protected key(event: KeyboardEvent) {
    const items = [...this.host.querySelectorAll<HTMLElement>('button')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      this.closed.emit();
    } else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
  }
}
