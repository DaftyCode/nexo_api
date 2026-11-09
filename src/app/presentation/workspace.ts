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
import { folders } from '../domain/collection-tree';
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
  protected toggle(id: string) {
    this.collapsed.update((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  }
  /** OAuth 2.0 set on the request itself: obtains or renews its token. */
  protected async requestToken(refresh: boolean) {
    const tab = this.state.active();
    if (!tab) return;
    const token = await this.state.oauth2Token(
      tab.request.auth,
      this.state.activeAncestors(),
      refresh,
    );
    const current = this.state.active();
    if (token && current?.id === tab.id)
      this.state.edit({ ...current.request, auth: withOAuth2Token(current.request.auth, token) });
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
  protected async submitDialog() {
    const m = this.formModel();
    if (this.dialogs() === 'collection') await this.state.createCollection(m.name);
    if (this.dialogs() === 'import') await this.state.importContent(m.content);
    if (this.dialogs() === 'workspace') await this.state.createWorkspace(m.name);
    const target = this.dialogTarget();
    if (target && this.dialogs() === 'folder')
      await this.state.addFolder(target.document, m.name, target.path);
    if (target && this.dialogs() === 'rename')
      await this.state.renameItem(target.document, target.path, m.name);
    if (!this.state.error()) this.dialogs.set('');
  }
  protected async file(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.formModel.update((m) => ({ ...m, content: '' }));
    if (file) {
      const content = await this.state.cases.files.read(file);
      await this.state.importContent(content);
      if (!this.state.error()) this.dialogs.set('');
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
