import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  afterNextRender,
  signal,
  HostListener,
  viewChild,
  ElementRef,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormField, form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { RequestEditor } from './request-editor';
import { ResponseView } from './response-view';
import { ToolsPanel } from './tools-panel';
import { WorkspaceDocument, CollectionItem, asCollection } from '../domain/models';
import { DropPosition, dropPlace, folders, isWithin } from '../domain/collection-tree';
import { withOAuth2Token } from '../domain/auth';
import { AppearanceState } from './appearance-state';
import { AppearanceSelector } from './appearance-selector';
import { Splitter } from './splitter';
import { LanguageSelector } from './language-selector';
import { LanguageState } from './language-state';
import { StudioIcon } from './studio-icon';
import { WorkspaceContext } from './workspace-context';
import { VariableQuickLook } from './variable-quick-look';
import { OAuth2SignInDialog } from './oauth2-sign-in';
import { OAuth2TokensDialog } from './oauth2-tokens';
import { CookiesDialog } from './cookies-dialog';
import { ReportPreview } from './report-preview';
import { ToastMessage } from './toast-message';
import { CodeEditor } from './code-editor';

@Component({
  imports: [
    Splitter,
    TranslocoPipe,
    FormField,
    DatePipe,
    RequestEditor,
    ResponseView,
    ToolsPanel,
    AppearanceSelector,
    LanguageSelector,
    StudioIcon,
    WorkspaceContext,
    VariableQuickLook,
    OAuth2SignInDialog,
    OAuth2TokensDialog,
    CookiesDialog,
    ReportPreview,
    ToastMessage,
    CodeEditor,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace',
  styleUrl: './workspace.scss',
  templateUrl: './workspace.html',
})
export class Workspace {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly state = inject(WorkspaceState);
  protected readonly appearance = inject(AppearanceState);
  protected readonly language = inject(LanguageState);
  private readonly workspaceSearch = viewChild<ElementRef<HTMLInputElement>>('workspaceSearch');
  private readonly collectionSearch = viewChild<ElementRef<HTMLInputElement>>('collectionSearch');
  protected readonly dialogs = signal('');
  /** Collection item a folder or rename dialog applies to. */
  private readonly dialogTarget = signal<
    { document: WorkspaceDocument; path: number[] } | undefined
  >(undefined);
  protected readonly navigationOpen = signal(false);
  protected readonly formModel = signal({
    name: '',
    content: '',
    workspace: '',
    environment: '',
    search: '',
  });
  protected readonly fields = form(this.formModel);
  protected readonly nav = [
    { id: 'collections', icon: '▤', label: 'Collections' },
    { id: 'environments', icon: '◫', label: 'Environments' },
    { id: 'history', icon: '◷', label: 'History' },
    { id: 'runner', icon: '▷', label: 'Runner' },
    { id: 'realtime', icon: '⇄', label: 'Protocols' },
    { id: 'mocks', icon: '◇', label: 'Mocks' },
    { id: 'datasets', icon: '▦', label: 'Datasets' },
    { id: 'mongo', icon: '⬮', label: 'MongoDB' },
    { id: 'git', icon: '⑂', label: 'Git' },
    { id: 'mcp', icon: '⌘', label: 'MCP' },
    { id: 'settings', icon: '⚙', label: 'Settings' },
  ];
  protected readonly collapsed = signal<string[]>([]);
  constructor() {
    afterNextRender(() => void this.state.initialize());
  }
  @HostListener('window:keydown', ['$event']) protected shortcuts(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    // Inside text areas and code editors, Enter and T keep their editing meaning.
    const editing = !!target?.closest('textarea, [contenteditable="true"], .code-editor');
    if (event.key === 'F1' || ((event.ctrlKey || event.metaKey) && event.key === '/')) {
      event.preventDefault();
      this.dialogs.set('shortcuts');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.state.section.set('collections');
      (this.workspaceSearch() ?? this.collectionSearch())?.nativeElement.focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !editing) {
      event.preventDefault();
      void this.state.send();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.state.saveActive();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't' && !editing) {
      event.preventDefault();
      this.state.newTab();
    }
  }
  /** A panel size as a CSS length, or nothing to keep the template's own. */
  protected px(size: number | undefined) {
    return size ? `${size}px` : null;
  }
  protected setSection(id: string) {
    this.state.section.set(id);
    this.navigationOpen.set(false);
  }
  protected browseCollections() {
    this.state.section.set('collections');
    this.navigationOpen.set(true);
  }
  protected closeNavigation() {
    this.navigationOpen.set(false);
    if (this.appearance.current() === 'canvas' && this.state.section() === 'history') {
      this.state.section.set('collections');
    }
  }
  /** Collapsed state key of a folder, next to the ids of collapsed collections. */
  protected folderKey(collection: string, path: readonly number[]) {
    return `${collection}/${path.join('.')}`;
  }
  /** Items of a collection shown in the tree: those inside a collapsed folder are hidden. */
  protected visibleEntries(collection: string) {
    const collapsed = this.collapsed();
    return (this.state.trees().get(collection) ?? []).filter(
      (entry) =>
        !entry.path
          .slice(0, -1)
          .some((_, index) =>
            collapsed.includes(this.folderKey(collection, entry.path.slice(0, index + 1))),
          ),
    );
  }
  /** The item being dragged in the tree. */
  private readonly dragging = signal<{ collection: string; path: number[] } | undefined>(undefined);
  /** Where the dragged item would land, to draw it; `invalid` for a folder into itself. */
  protected readonly dropHint = signal<
    { collection: string; key: string; position: DropPosition; invalid: boolean } | undefined
  >(undefined);
  protected dragStart(
    event: DragEvent,
    collection: WorkspaceDocument,
    path: number[],
    name: string,
  ) {
    this.dragging.set({ collection: collection.id, path });
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox only starts a drag with some data.
      event.dataTransfer.setData('text/plain', name);
    }
  }
  /** Before or after a request; before, inside or after a folder, by where the pointer is. */
  private position(event: DragEvent, folder: boolean): DropPosition {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (event.clientY - box.top) / Math.max(box.height, 1);
    if (!folder) return ratio < 0.5 ? 'before' : 'after';
    return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
  }
  /** Only within the collection the item comes from. `path` `[]` is the collection itself. */
  protected dragOver(
    event: DragEvent,
    collection: WorkspaceDocument,
    path: number[],
    folder: boolean,
  ) {
    const dragged = this.dragging();
    if (!dragged || dragged.collection !== collection.id) return;
    event.preventDefault();
    const position = path.length ? this.position(event, folder) : 'inside';
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropHint.set({
      collection: collection.id,
      key: path.join('.'),
      position,
      invalid: isWithin(dropPlace(path, position).folder, dragged.path),
    });
  }
  /** The hint of a row: where the item would land next to it, if anywhere. */
  protected hint(collection: string, path: number[]) {
    const hint = this.dropHint();
    return hint?.collection === collection && hint.key === path.join('.') ? hint : undefined;
  }
  protected drop(event: DragEvent, collection: WorkspaceDocument, path: number[], folder: boolean) {
    const dragged = this.dragging();
    this.dragEnd();
    if (!dragged || dragged.collection !== collection.id) return;
    event.preventDefault();
    const position = path.length ? this.position(event, folder) : 'inside';
    // A folder that receives an item opens, so the item stays in sight.
    if (position === 'inside' && path.length)
      this.collapsed.update((list) =>
        list.filter((key) => key !== this.folderKey(collection.id, path)),
      );
    void this.state.dropItem(collection, dragged.path, path, position);
  }
  protected dragEnd() {
    this.dragging.set(undefined);
    this.dropHint.set(undefined);
  }
  protected toggle(id: string) {
    this.collapsed.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  }
  /** OAuth 2.0 set on the request itself: obtains or renews its token. */
  protected async requestToken(refresh: boolean) {
    const tab = this.state.active();
    if (!tab) return;
    // The token is selected in the request and saved in its collection right away.
    await this.state.oauth2Token(
      tab.request.auth,
      this.state.activeAncestors(),
      refresh,
      async (token) => {
        const current = this.state.tabs().find((t) => t.id === tab.id);
        if (!current) return 'vault';
        return this.state.keepRequestAuth(current.id, withOAuth2Token(current.request.auth, token));
      },
    );
  }
  protected method(item: CollectionItem) {
    return typeof item.request === 'object' ? String(item.request['method'] ?? 'GET') : 'GET';
  }
  /** Closes an actions menu after one of its buttons is used, or after a click outside it. */
  @HostListener('click', ['$event']) protected closeMenu(event: Event) {
    const target = event.target as HTMLElement;
    const menu = target.closest('details.collection-menu');
    if (!menu) this.closeMenus();
    else if (target.closest('button') && !target.closest('summary')) menu.removeAttribute('open');
  }
  /** Resizing and Escape close the floating menus. */
  @HostListener('window:resize')
  @HostListener('document:keydown.escape')
  protected closeMenus(except?: Element) {
    for (const menu of this.host.nativeElement.querySelectorAll('details.collection-menu[open]'))
      if (menu !== except) menu.removeAttribute('open');
  }
  /**
   * The sidebar scrolled: open menus follow their button, and close once it is scrolled out
   * of sight. Clicking a button near the edge scrolls it into view first, so closing on any
   * scroll would close the menu that click opened.
   */
  protected followMenus(sidebar: HTMLElement) {
    const visible = sidebar.getBoundingClientRect();
    for (const menu of sidebar.querySelectorAll<HTMLDetailsElement>(
      'details.collection-menu[open]',
    )) {
      const anchor = menu.querySelector('summary')?.getBoundingClientRect();
      if (anchor && anchor.bottom > visible.top && anchor.top < visible.bottom) this.place(menu);
      else menu.removeAttribute('open');
    }
  }
  protected placeMenu(event: Event) {
    const menu = event.target as HTMLDetailsElement;
    if (!menu.open) {
      delete menu.dataset['placed'];
      return;
    }
    this.closeMenus(menu);
    this.place(menu);
  }
  /**
   * Places an opened actions menu against the window, below its button and towards the next
   * panel, kept inside the window. The sidebar clips its overflow, so a menu inside it would
   * be cut off when it is wider than the sidebar.
   */
  private place(menu: HTMLDetailsElement) {
    const summary = menu.querySelector('summary');
    const panel = menu.querySelector<HTMLElement>(':scope > div');
    if (!summary || !panel) return;
    const margin = 8;
    const anchor = summary.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    const below = anchor.bottom + 4;
    const top =
      below + height + margin <= window.innerHeight
        ? below
        : Math.max(margin, anchor.top - height - 4);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    menu.dataset['placed'] = '';
  }
  protected dialogTitle() {
    const titles: Record<string, string> = {
      import: 'Import your work',
      collection: 'Create collection',
      workspace: 'Create workspace',
      folder: 'Create folder',
      rename: 'Rename',
      shortcuts: 'Keyboard shortcuts',
    };
    return titles[this.dialogs()] ?? '';
  }
  /** Runs the dialog's action; it closes when the action did not fail, which a toast tells. */
  protected async submitDialog() {
    const m = this.formModel();
    const target = this.dialogTarget();
    const dialog = this.dialogs();
    let done = true;
    if (dialog === 'collection') done = await this.state.createCollection(m.name);
    if (dialog === 'import') done = await this.state.importContent(m.content);
    if (dialog === 'workspace') done = await this.state.createWorkspace(m.name);
    if (target && dialog === 'folder')
      done = await this.state.addFolder(target.document, m.name, target.path);
    if (target && dialog === 'rename')
      done = await this.state.renameItem(target.document, target.path, m.name);
    if (done) this.dialogs.set('');
  }
  protected async file(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.formModel.update((m) => ({ ...m, content: '' }));
    if (file) {
      const content = await this.state.cases.files.read(file);
      if (await this.state.importContent(content)) this.dialogs.set('');
    }
  }
  protected async selectWorkspace(event: Event) {
    await this.state.selectWorkspace((event.target as HTMLSelectElement).value);
  }
  protected selectEnvironment(event: Event) {
    this.state.selectEnvironment((event.target as HTMLSelectElement).value);
  }
  protected search(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.state.filter.set(value);
    this.formModel.update((model) => ({ ...model, search: value }));
  }
  protected duplicate(document: WorkspaceDocument) {
    void this.state.guard(async () => {
      await this.state.cases.createDocument(
        this.state.workspaceId(),
        document.kind,
        `${document.name} copy`,
        structuredClone(document.value),
      );
      await this.state.refresh();
    });
  }
  protected folder(document: WorkspaceDocument, path: number[] = []) {
    this.dialogTarget.set({ document, path });
    this.formModel.update((m) => ({ ...m, name: '' }));
    this.dialogs.set('folder');
  }
  protected rename(document: WorkspaceDocument, path: number[], name: string) {
    this.dialogTarget.set({ document, path });
    this.formModel.update((m) => ({ ...m, name }));
    this.dialogs.set('rename');
  }
  protected folderChoices(document: WorkspaceDocument, path: number[]) {
    const all = folders(asCollection(document.value));
    // A folder cannot move into itself or one of its own folders.
    return all.filter(
      (folder) =>
        !(folder.path.length >= path.length && path.every((index, i) => folder.path[i] === index)),
    );
  }
  protected moveTo(document: WorkspaceDocument, path: number[], event: Event) {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    select.value = '';
    if (value === '') return;
    void this.state.moveItem(document, path, value === 'root' ? [] : value.split('.').map(Number));
  }
}
