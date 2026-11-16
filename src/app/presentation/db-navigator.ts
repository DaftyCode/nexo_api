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
import { NavigatorRow } from '../domain/db/rows';
import { DbBookmark } from '../domain/db/tree';
import { MongoDialog } from './mongo-dialog';
import { StudioIcon } from './studio-icon';
import { DbActions } from './db-panel/actions';
import { ICONS, MenuAction } from './db-panel/menu';
import { RowClicks } from './db-panel/row-clicks';
import { DbSection } from './db-panel/section';

/** Where the actions menu of a row is open. */
interface OpenMenu {
  row: NavigatorRow;
  x: number;
  y: number;
}

/**
 * The navigator of the database section, as DBeaver's: folders of connections, each one
 * opened by expanding it, and the tree its driver describes. A click opens or closes a row
 * and a double click opens a table's tab ({@link RowClicks}). A tree for the keyboard (arrows,
 * Enter, F2, F5, Delete, the menu key), with a text filter, bookmarks and two views.
 */
@Component({
  imports: [TranslocoPipe, FormField, MongoDialog, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-navigator',
  styleUrl: './db-navigator.scss',
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
  /** The connection being dragged to a folder. */
  protected readonly dragging = signal('');
  protected readonly dropKey = signal('');
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
    if (row.type === 'connection') return 'databases';
    if (row.type === 'folder' || row.type === 'scripts' || row.type === 'script-group')
      return 'folder';
    if (row.type === 'script') return 'code';
    return ICONS[row.node?.kind ?? ''] ?? 'datasets';
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
    if ((event.target as HTMLElement).closest('.db-twisty')) return;
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
    this.showMenu(row, box ? box.left + box.width / 3 : 0, box ? box.bottom : 0);
  }

  protected contextMenu(event: MouseEvent, row: NavigatorRow) {
    if (row.type === 'loading' || row.type === 'empty') return;
    event.preventDefault();
    this.select(row);
    this.showMenu(row, event.clientX, event.clientY);
  }

  private showMenu(row: NavigatorRow, x: number, y: number) {
    this.focusKey.set(row.key);
    this.menu.set({ row, x, y });
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

  protected menuKey(event: KeyboardEvent) {
    const items = [...this.host.querySelectorAll<HTMLElement>('.db-menu button')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      this.closeMenu();
    } else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
  }

  protected outside(event: Event) {
    if (this.menu() && !(event.target as HTMLElement).closest?.('.db-menu')) this.closeMenu(false);
  }

  protected async reveal(bookmark: DbBookmark) {
    const key = await this.section.reveal(bookmark);
    if (key) this.focus(key);
  }

  protected collapseAll() {
    this.section.tree.expanded.set(new Set());
  }

  // Connections dragged to a folder, or beside a connection of another folder.
  protected dragStart(event: DragEvent, row: NavigatorRow) {
    if (row.type !== 'connection' || !row.connection) return;
    this.dragging.set(row.connection);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.label);
    }
  }
  protected dragOver(event: DragEvent, row: NavigatorRow) {
    if (!this.dragging() || (row.type !== 'folder' && row.type !== 'connection')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropKey.set(row.key);
  }
  protected drop(event: DragEvent, row: NavigatorRow) {
    const document = this.section.connection(this.dragging());
    this.dragEnd();
    if (!document || (row.type !== 'folder' && row.type !== 'connection')) return;
    event.preventDefault();
    void this.actions.task.announce('The connection could not be moved', () =>
      this.actions.move(document, row.folder ?? ''),
    );
  }
  protected dragEnd() {
    this.dragging.set('');
    this.dropKey.set('');
  }
}
