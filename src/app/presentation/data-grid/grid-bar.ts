import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { StudioIcon } from '../studio-icon';
import type { GridMenuMode } from './grid-menu';

/** A tool of the bar that opens one of the grid's menus. */
const MENUS: { mode: GridMenuMode; icon: string; label: string }[] = [
  { mode: 'filter', icon: 'filter', label: 'Filter by this value' },
  { mode: 'columns', icon: 'columns', label: 'Columns shown' },
  { mode: 'export', icon: 'download', label: 'Export' },
];

/**
 * The bar above the grid: what the screen around it puts first (`[gridStart]`), the filter
 * over the rows loaded, the menus of quick filters, columns shown and export, full screen;
 * and, under it, the find bar when it is open (Ctrl+F).
 */
@Component({
  imports: [TranslocoPipe, FormField, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-grid-bar',
  styleUrl: './grid-bar.scss',
  template: `
    <div class="grid-toolbar" role="toolbar" [attr.aria-label]="'Grid tools' | transloco">
      <ng-content select="[gridStart]" />
      <span class="grow"></span>
      <label class="grid-search">
        <app-studio-icon name="search" />
        <input
          type="search"
          [formField]="filterField"
          autocomplete="off"
          spellcheck="false"
          [placeholder]="'Filter in results…' | transloco"
          [attr.aria-label]="'Filter loaded rows' | transloco"
        />
      </label>
      @for (tool of menus; track tool.mode) {
        @if (tool.mode !== 'filter' || filters()) {
          <button
            type="button"
            class="icon-button grid-tool"
            aria-haspopup="menu"
            [disabled]="tool.mode === 'filter' && !active()"
            [attr.aria-label]="tool.label | transloco"
            [attr.title]="tool.label | transloco"
            (click)="$event.stopPropagation(); menu.emit({ mode: tool.mode, event: $event })"
          >
            <app-studio-icon [name]="tool.icon" />
          </button>
        }
      }
      @if (away()) {
        <button type="button" class="button small" (click)="back.emit()">
          <app-studio-icon name="table" />{{ 'Back to the grid' | transloco }}
        </button>
      }
      <button
        type="button"
        class="icon-button grid-tool"
        [attr.aria-pressed]="maximized()"
        [attr.aria-label]="'Full screen' | transloco"
        [attr.title]="'Full screen' | transloco"
        (click)="maximized.set(!maximized())"
      >
        <app-studio-icon [name]="maximized() ? 'collapse' : 'expand'" />
      </button>
    </div>
    @if (finding()) {
      <div class="grid-find" role="search">
        <label class="grid-search"
          ><app-studio-icon name="search" /><input
            type="search"
            [formField]="findField"
            autocomplete="off"
            spellcheck="false"
            [attr.aria-label]="'Find in results' | transloco"
            [placeholder]="'Find in results' | transloco"
            (keydown.enter)="next.emit($any($event).shiftKey)"
            (keydown.escape)="finding.set(false)"
        /></label>
        <span class="grid-count" role="status">{{
          'db.grid.found' | transloco: { v0: found() }
        }}</span>
        <button type="button" class="button small subtle" (click)="next.emit(true)">
          {{ 'Previous' | transloco }}
        </button>
        <button type="button" class="button small subtle" (click)="next.emit(false)">
          {{ 'Next' | transloco }}
        </button>
        <button
          type="button"
          class="icon-button"
          [attr.aria-label]="'Close' | transloco"
          (click)="finding.set(false)"
        >
          ×
        </button>
      </div>
    }
  `,
})
export class GridBar {
  /** The text that filters the rows loaded, and the text found in them. */
  readonly filter = model('');
  readonly find = model('');
  readonly finding = model(false);
  readonly maximized = model(false);
  /** The screen offers quick filters, and there is an active cell to filter by. */
  readonly filters = input(false);
  readonly active = input(false);
  readonly found = input(0);
  /** The record or the text view is shown instead of the grid. */
  readonly away = input(false);
  readonly back = output<void>();
  readonly menu = output<{ mode: GridMenuMode; event: MouseEvent }>();
  /** Find the next match, or the one before (`true`). */
  readonly next = output<boolean>();
  protected readonly menus = MENUS;
  protected readonly filterField = form(this.filter);
  protected readonly findField = form(this.find);
}
