import { TranslocoPipe } from '@jsverse/transloco';
import { TEMPLATE_FOLDERS } from '../../domain/db/ddl-templates';
import { editsStructure } from './structure-request';
import { administers } from './admin';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NavigatorRow } from '../../domain/db/rows';
import { NATIVE_FILES } from '../../composition/providers';
import { readDbConnection } from '../../domain/db/connection';
import { hasNativeTools } from '../../domain/db/native';
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
      [style.max-height.px]="maxHeight()"
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
        @if (row().node?.kind === 'folder' && row().node?.name === 'tables' && structure()) {
          <button type="button" role="menuitem" (click)="chosen.emit('newTable')">
            {{ 'New table…' | transloco }}
          </button>
        }
        @if (row().node?.kind === 'folder' && templated()) {
          <button type="button" role="menuitem" (click)="chosen.emit('newObject')">
            {{ 'db.structure.newObject' | transloco: { v0: row().label } }}
          </button>
        }
        @if (row().path?.at(-2) === 'materialized-views' && row().node?.kind !== 'folder') {
          <button type="button" role="menuitem" (click)="chosen.emit('refreshView')">
            {{ 'Refresh materialized view' | transloco }}
          </button>
        }
        @if (row().node?.actions?.includes('open')) {
          <button type="button" role="menuitem" (click)="chosen.emit('open')">
            {{ 'Open' | transloco }}
          </button>
        }
        @if (diagrammed()) {
          <button type="button" role="menuitem" (click)="chosen.emit('viewDiagram')">
            {{ 'View diagram' | transloco }}
          </button>
        }
        @if (row().node?.actions?.includes('data')) {
          <button type="button" role="menuitem" (click)="chosen.emit('viewData')">
            {{ 'View data' | transloco }}
          </button>
          @for (kind of generated; track kind[0]) {
            <button type="button" role="menuitem" (click)="chosen.emit(kind[0])">
              {{ 'db.generate' | transloco: { v0: kind[1] } }}
            </button>
          }
          @for (each of transfers; track each[0]) {
            <button type="button" role="menuitem" (click)="chosen.emit(each[0])">
              {{ each[1] | transloco }}
            </button>
          }
          @if (row().node?.kind === 'table' && structure()) {
            @for (each of tableStructure; track each[0]) {
              <button
                type="button"
                role="menuitem"
                [class.danger]="each[0] !== 'editStructure'"
                (click)="chosen.emit(each[0])"
              >
                {{ each[1] | transloco }}
              </button>
            }
          }
        }
      }
      @if (row().type === 'connection') {
        <button type="button" role="menuitem" (click)="chosen.emit('console')">
          {{ 'SQL console' | transloco }}
        </button>
        <button type="button" role="menuitem" (click)="chosen.emit('newDiagram')">
          {{ 'New diagram' | transloco }}
        </button>
        <button type="button" role="menuitem" (click)="chosen.emit('dashboard')">
          {{ 'Dashboard' | transloco }}
        </button>
        @if (admin().sessions) {
          <button type="button" role="menuitem" (click)="chosen.emit('sessions')">
            {{ 'Sessions' | transloco }}
          </button>
        }
        @if (admin().locks) {
          <button type="button" role="menuitem" (click)="chosen.emit('locks')">
            {{ 'Locks' | transloco }}
          </button>
        }
        @if (native()) {
          <button type="button" role="menuitem" (click)="chosen.emit('native')">
            {{ 'Backup and restore…' | transloco }}
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
      @if (row().type === 'diagram') {
        <button type="button" role="menuitem" (click)="chosen.emit('open')">
          {{ 'Open' | transloco }}
        </button>
        <button type="button" role="menuitem" class="danger" (click)="chosen.emit('deleteDiagram')">
          {{ 'Delete diagram' | transloco }} <kbd>Del</kbd>
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
      @if (['folder', 'error', 'scripts', 'diagrams'].includes(row().type)) {
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
  /** The tallest it may be to stay in the window. */
  readonly maxHeight = input<number | undefined>(undefined);
  readonly chosen = output<MenuAction>();
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  /** «Generate SQL» of a table or view, as DBeaver's. */
  protected readonly generated = [
    ['generateSelect', 'SELECT'],
    ['generateInsert', 'INSERT'],
    ['generateUpdate', 'UPDATE'],
    ['generateDelete', 'DELETE'],
    ['generateMerge', 'MERGE'],
  ] as const;
  /** A folder whose new objects start from a template of their engine (DB-19). */
  protected readonly templated = computed(() =>
    (TEMPLATE_FOLDERS as readonly string[]).includes(this.row().node?.name ?? ''),
  );
  /** The sessions and locks of the server of a connection (DB-21), when its driver lists them. */
  protected readonly admin = computed(() => administers(this.section, this.row().connection));
  /** The local client tools of its engine, in the desktop app (DB-23). */
  protected readonly native = computed(() => {
    const document = this.section.connection(this.row().connection ?? '');
    return (
      this.nativeFiles.available &&
      !!document &&
      hasNativeTools(readDbConnection(document.value).driver)
    );
  });
  private readonly nativeFiles = inject(NATIVE_FILES);
  /** Tables, schemas, databases and folders of tables have a diagram (DB-20). */
  protected readonly diagrammed = computed(() => {
    const node = this.row().node;
    return (
      ['table', 'schema', 'database'].includes(node?.kind ?? '') ||
      (node?.kind === 'folder' && node.name === 'tables')
    );
  });
  /** The structure of a table (DB-19), when its driver edits it. */
  protected readonly structure = computed(() =>
    editsStructure(this.section, this.row().connection),
  );
  protected readonly tableStructure = [
    ['editStructure', 'Edit structure…'],
    ['emptyTable', 'Empty table…'],
    ['dropTable', 'Drop table…'],
  ] as const;
  /** Data in and out of a table (DB-17). */
  protected readonly transfers = [
    ['exportData', 'Export data…'],
    ['importData', 'Import data…'],
    ['copyData', 'Copy to another connection…'],
  ] as const;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterNextRender(() => {
      this.host.querySelector<HTMLElement>('button')?.focus();
      // What the driver can do decides some entries: it is asked once, connected or not.
      const connection = this.row().type === 'connection' ? this.row().connection : undefined;
      if (connection) void this.section.drivers.learn(connection).catch(() => undefined);
    });
  }

  protected key(event: KeyboardEvent) {
    menuKeys(event, this.host, () => this.closed.emit());
  }
}
