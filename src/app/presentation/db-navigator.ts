import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { compactCount, detailRows, nodeIcon } from '../domain/db/look';
import { NavigatorRow } from '../domain/db/rows';
import { DbBookmark } from '../domain/db/tree';
import { MongoDialog } from './mongo-dialog';
import { StudioIcon } from './studio-icon';
import { DbActions } from './db-panel/actions';
import { MenuAction } from './db-panel/menu';
import { RowClicks } from './db-panel/row-clicks';
import { NavigatorDrag } from './db-navigator/drag';
import { DbRowMenu } from './db-panel/row-menu';
import { menuKeys } from './menu-keys';
import { PopupPlace, placeAt, placeBy } from './popup-place';
import { DbSection } from './db-panel/section';

/** Where the actions menu of a row is open. */
interface OpenMenu extends PopupPlace {
  row: NavigatorRow;
}

/**
 * The navigator of the database section, as DBeaver's: folders of connections, each one
 * opened by expanding it, and the tree its driver describes. A click opens or closes a row
 * and a double click opens a table's tab ({@link RowClicks}). A tree for the keyboard (arrows,
 * Enter, F2, F5, Delete, the menu key), with a text filter, bookmarks and two views.
 */
@Component({
  imports: [TranslocoPipe, FormField, MongoDialog, StudioIcon, DbRowMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-navigator',
  styleUrls: ['./db-navigator.scss', './db-navigator/rows.scss'],
  templateUrl: './db-navigator.html',
  host: { '(document:click)': 'outside($event)' },
})
export class DbNavigator {
  protected readonly section = inject(DbSection);
  protected readonly actions = new DbActions(this.section);
  private readonly clicks = new RowClicks(this.section, this.actions);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  protected readonly filterModel = signal({ text: '' });
  protected readonly filterFields = form(this.filterModel);
  protected readonly rows = this.section.rows;
  /** The row with the keyboard focus (roving tabindex). */
  protected readonly focusKey = signal('');
  protected readonly menu = signal<OpenMenu | undefined>(undefined);
  /** Where the menu of the navigator's options is open. */
  protected readonly options = signal<PopupPlace | undefined>(undefined);
  /** The connections' list, folded under its heading. */
  protected readonly folded = signal(false);
  /** Connections dragged to a folder, and tables to a diagram. */
  protected readonly drag = new NavigatorDrag(this.section, this.actions);
  protected readonly current = computed((): NavigatorRow | undefined => {
    const rows = this.rows();
    return rows.find((row) => row.key === this.focusKey()) ?? rows[0];
  });

  constructor() {
    effect(() => this.section.text.set(this.filterModel().text));
    inject(DestroyRef).onDestroy(() => this.clicks.stop());
  }

  /** The icon of a row, by the class of object the driver says it is. */
  protected icon(row: NavigatorRow) {
    if (row.type === 'script') return 'code';
    if (row.type === 'diagram') return 'schema';
    return row.node ? nodeIcon(row.node) : 'folder';
  }
  /** How many objects a folder of the tree holds, once they are loaded. */
  protected count(row: NavigatorRow) {
    if (row.node?.kind !== 'folder') return undefined;
    return this.section.tree.children().get(row.key)?.length;
  }
  /** The rows a driver estimates for a table, written short. */
  protected rowsOf(detail: string) {
    const rows = detailRows(detail);
    return rows === undefined ? undefined : compactCount(rows);
  }
  protected tabIndex(row: NavigatorRow) {
    return row.key === this.current()?.key ? 0 : -1;
  }
  protected rowId(row: NavigatorRow) {
    return `db-node-${encodeURIComponent(row.key).replace(/%/g, '_')}`;
  }
  protected statusLabel(row: NavigatorRow) {
    return `db.status.${row.status ?? 'disconnected'}`;
  }

  /** Moves the focus to a row, once it is drawn. */
  private focus(key: string) {
    this.focusKey.set(key);
    afterNextRender(
      () =>
        this.host
          .querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
          ?.focus({ preventScroll: false }),
      { injector: this.injector },
    );
  }

  protected select(row: NavigatorRow) {
    this.focusKey.set(row.key);
    if (row.connection) this.section.active.set(row.connection);
  }

  /** A click selects a row and opens or closes it. */
  protected click(event: MouseEvent, row: NavigatorRow) {
    this.select(row);
    this.clicks.click(row, !!(event.target as HTMLElement).closest('.db-twisty'), event.detail);
  }

  protected doubleClick(event: MouseEvent, row: NavigatorRow) {
    if ((event.target as HTMLElement).closest('.db-twisty, .db-kebab')) return;
    this.select(row);
    this.clicks.double(row);
  }

  protected activate(row: NavigatorRow) {
    this.select(row);
    this.clicks.activate(row);
  }

  /** The keys of a WAI-ARIA tree, and the shortcuts of DBeaver's navigator. */
  protected key(event: KeyboardEvent, row: NavigatorRow) {
    const rows = this.rows();
    if (this.menu()) return;
    this.focusKey.set(row.key);
    const index = rows.indexOf(row);
    const go = (target: NavigatorRow | undefined) => {
      if (!target) return;
      event.preventDefault();
      this.select(target);
      this.focus(target.key);
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(rows[index + 1]);
      case 'ArrowUp':
        return go(rows[index - 1]);
      case 'Home':
        return go(rows[0]);
      case 'End':
        return go(rows.at(-1));
      case 'ArrowRight':
        event.preventDefault();
        if (row.expandable && !row.expanded) void this.actions.toggle(row);
        else if (row.expanded)
          go(rows[index + 1]?.parent === row.key ? rows[index + 1] : undefined);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.expanded) void this.actions.toggle(row);
        else go(rows.find((other) => other.key === row.parent));
        return;
      case 'Enter':
        event.preventDefault();
        return this.activate(row);
      case 'F2':
        event.preventDefault();
        return this.actions.rename(row);
      case 'F5':
        event.preventDefault();
        return void this.actions.refresh(row);
      case 'Delete':
        event.preventDefault();
        if (row.type === 'diagram') return this.actions.deleteDiagram(row);
        return row.type === 'script' ? this.actions.deleteScript(row) : this.actions.remove(row);
      case ']':
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        return this.actions.newScript(row);
      case 'ContextMenu':
        event.preventDefault();
        return this.openMenuAt(row);
      case 'F10':
        if (!event.shiftKey) return;
        event.preventDefault();
        return this.openMenuAt(row);
    }
  }

  /** Opens the actions menu of a row by its element, for the keyboard and the toolbar. */
  protected openMenuAt(row: NavigatorRow | undefined) {
    if (!row || row.type === 'loading' || row.type === 'empty') return;
    const element = this.host.querySelector<HTMLElement>(`[data-key="${CSS.escape(row.key)}"]`);
    const box = element?.getBoundingClientRect();
    const left = box ? box.left + box.width / 3 : 0;
    this.showMenu(row, box ? { ...placeBy(element!), x: placeAt(left, 0).x } : placeAt(0, 0));
  }

  protected contextMenu(event: MouseEvent, row: NavigatorRow) {
    if (row.type === 'loading' || row.type === 'empty') return;
    event.preventDefault();
    this.select(row);
    this.showMenu(row, placeAt(event.clientX, event.clientY));
  }

  private showMenu(row: NavigatorRow, at: PopupPlace) {
    this.options.set(undefined);
    this.focusKey.set(row.key);
    this.menu.set({ row, ...at });
    afterNextRender(() => this.host.querySelector<HTMLElement>('.db-menu button')?.focus(), {
      injector: this.injector,
    });
  }

  protected closeMenu(restore = true) {
    const open = this.menu();
    this.menu.set(undefined);
    if (open && restore) this.focus(open.row.key);
  }

  /** Runs a menu entry and closes the menu. */
  protected run(action: MenuAction) {
    const open = this.menu();
    if (!open) return;
    this.closeMenu();
    void this.actions[action](open.row);
  }

  /** Opens or closes the navigator's options under their button. */
  protected toggleOptions(event: MouseEvent) {
    if (this.options()) return this.options.set(undefined);
    this.options.set(placeBy(event.currentTarget as HTMLElement));
    afterNextRender(
      () => this.host.querySelector<HTMLElement>('.db-options-menu button')?.focus(),
      { injector: this.injector },
    );
  }
  protected optionsKey(event: KeyboardEvent) {
    menuKeys(event, event.currentTarget as HTMLElement, () => {
      this.options.set(undefined);
      this.host.querySelector<HTMLElement>('.db-nav-options')?.focus();
    });
  }

  protected outside(event: Event) {
    const target = event.target as HTMLElement;
    if (this.menu() && !target.closest?.('.popup-menu')) this.closeMenu(false);
    if (this.options() && !target.closest?.('.popup-menu')) this.options.set(undefined);
  }

  protected async reveal(bookmark: DbBookmark) {
    const key = await this.section.reveal(bookmark);
    if (key) this.focus(key);
  }

  protected collapseAll() {
    this.section.tree.expanded.set(new Set());
  }
}
