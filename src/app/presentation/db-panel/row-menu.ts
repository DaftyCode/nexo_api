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
import { NavigatorRow } from '../../domain/db/rows';
import { menuKeys } from '../menu-keys';
import { MenuAction } from './menu';
import { DbSection } from './section';

/**
 * The actions menu of a row of the navigator, at the mouse or under the row: what a
 * connection, a node, a folder or a script allows. A WAI-ARIA menu for the keyboard.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-row-menu',
  template: `
    <div
      class="popup-menu"
      role="menu"
      tabindex="-1"
      [attr.aria-label]="'db.menu' | transloco: { v0: row().label }"
      [style.left.px]="x()"
      [style.top.px]="y()"
      [style.bottom.px]="bottom()"
      (keydown)="key($event)"
      (click)="$event.stopPropagation()"
    >
      @if (row().type === 'connection') {
        @if (row().status === 'connected') {
          <button type="button" role="menuitem" (click)="chosen.emit('disconnect')">
            {{ 'Disconnect' | transloco }}
          </button>
          <button type="button" role="menuitem" (click)="chosen.emit('reconnect')">
            {{ 'Reconnect' | transloco }}
          </button>
        } @else {
          <button type="button" role="menuitem" (click)="chosen.emit('connect')">
            {{ 'Connect' | transloco }}
          </button>
        }
        <button type="button" role="menuitem" (click)="chosen.emit('edit')">
          {{ 'Edit connection' | transloco }}
        </button>
        <button type="button" role="menuitem" (click)="chosen.emit('rename')">
          {{ 'Rename' | transloco }} <kbd>F2</kbd>
        </button>
        <button type="button" role="menuitem" (click)="chosen.emit('duplicate')">
          {{ 'Duplicate' | transloco }}
        </button>
        <button type="button" role="menuitem" (click)="chosen.emit('moveTo')">
          {{ 'Move to folder' | transloco }}
        </button>
      }
      @if (row().type === 'node') {
        @if (row().node?.actions?.includes('open')) {
          <button type="button" role="menuitem" (click)="chosen.emit('open')">
            {{ 'Open' | transloco }}
          </button>
        }
        @if (row().node?.actions?.includes('data')) {
          <button type="button" role="menuitem" (click)="chosen.emit('viewData')">
            {{ 'View data' | transloco }}
          </button>
        }
      }
      @if (row().type === 'connection' || row().type === 'node' || row().type === 'script-group') {
        <button type="button" role="menuitem" (click)="chosen.emit('newScript')">
          {{ 'New SQL script' | transloco }} <kbd>Ctrl+]</kbd>
        </button>
      }
      @if (row().type === 'script') {
        <button type="button" role="menuitem" (click)="chosen.emit('open')">
          {{ 'Open' | transloco }}
        </button>
        <button type="button" role="menuitem" class="danger" (click)="chosen.emit('deleteScript')">
          {{ 'Delete script' | transloco }}
        </button>
      }
      @if (row().type === 'node') {
        <button type="button" role="menuitem" (click)="chosen.emit('copyName')">
          {{ 'Copy name' | transloco }}
        </button>
        @if (row().node?.actions?.includes('ddl')) {
          <button type="button" role="menuitem" (click)="chosen.emit('copyDdl')">
            {{ 'Copy DDL' | transloco }}
          </button>
        }
      }
      @if (row().type === 'connection' || row().type === 'node') {
        <button type="button" role="menuitem" (click)="chosen.emit('bookmark')">
          {{ (section.isBookmarked(row().key) ? 'Remove bookmark' : 'Bookmark') | transloco }}
        </button>
        @if (row().expandable) {
          <button type="button" role="menuitem" (click)="chosen.emit('filter')">
            {{ 'Filter objects' | transloco }}
          </button>
          <button type="button" role="menuitem" (click)="chosen.emit('refresh')">
            {{ 'Refresh' | transloco }} <kbd>F5</kbd>
          </button>
        }
      }
      @if (row().type === 'connection') {
        <button type="button" role="menuitem" class="danger" (click)="chosen.emit('remove')">
          {{ 'Delete' | transloco }} <kbd>Del</kbd>
        </button>
      }
      @if (row().type === 'folder' || row().type === 'error' || row().type === 'scripts') {
        <button type="button" role="menuitem" (click)="closed.emit()">
          {{ 'Close' | transloco }}
        </button>
      }
    </div>
  `,
})
export class DbRowMenu {
  readonly row = input.required<NavigatorRow>();
  readonly x = input(0);
  readonly y = input<number | undefined>(undefined);
  /** Opened over the row: the distance from the window's foot to the menu's bottom. */
  readonly bottom = input<number | undefined>(undefined);
  readonly chosen = output<MenuAction>();
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterNextRender(() => this.host.querySelector<HTMLElement>('button')?.focus());
  }

  protected key(event: KeyboardEvent) {
    menuKeys(event, this.host, () => this.closed.emit());
  }
}
