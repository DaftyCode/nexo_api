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
import { form } from '@angular/forms/signals';
import { WorkspaceState } from './workspace-state';
import { RequestEditor } from './request-editor';
import { ResponseView } from './response-view';
import { ToolsPanel } from './tools-panel';
import { WorkspaceDocument } from '../domain/models';
import { FloatingMenus } from './workspace/floating-menus';
import { CollectionTreeView } from './workspace/tree-view';
import { WorkspaceDialogs } from './workspace-dialogs';
import { WorkspaceNavigation } from './workspace-navigation';
import { WorkspaceTopbar } from './workspace-topbar';
import { withOAuth2Token } from '../domain/auth';
import { AppearanceState } from './appearance-state';
import { Splitter } from './splitter';
import { LanguageState } from './language-state';
import { WorkspaceContext } from './workspace-context';
import { VariableQuickLook } from './variable-quick-look';
import { OAuth2SignInDialog } from './oauth2-sign-in';
import { OAuth2TokensDialog } from './oauth2-tokens';
import { CookiesDialog } from './cookies-dialog';
import { ReportPreview } from './report-preview';
import { ToastMessage } from './toast-message';

@Component({
  imports: [
    Splitter,
    TranslocoPipe,
    RequestEditor,
    ResponseView,
    ToolsPanel,
    WorkspaceContext,
    VariableQuickLook,
    OAuth2SignInDialog,
    OAuth2TokensDialog,
    CookiesDialog,
    ReportPreview,
    ToastMessage,
    WorkspaceNavigation,
    WorkspaceTopbar,
    WorkspaceDialogs,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace',
  styleUrl: './workspace.scss',
  templateUrl: './workspace.html',
})
export class Workspace {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly state = inject(WorkspaceState);
  readonly appearance = inject(AppearanceState);
  readonly language = inject(LanguageState);
  private readonly topbar = viewChild(WorkspaceTopbar);
  private readonly navigation = viewChild(WorkspaceNavigation);
  readonly dialogs = signal('');
  /** Collection item a folder or rename dialog applies to. */
  private readonly dialogTarget = signal<
    { document: WorkspaceDocument; path: number[] } | undefined
  >(undefined);
  readonly navigationOpen = signal(false);
  protected readonly formModel = signal({
    name: '',
    content: '',
    workspace: '',
    environment: '',
    search: '',
  });
  readonly fields = form(this.formModel);
  readonly nav = [
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
  readonly tree = new CollectionTreeView(this.state);
  readonly menus = new FloatingMenus(this.host.nativeElement);
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
      (
        this.topbar()?.workspaceSearch() ?? this.navigation()?.collectionSearch()
      )?.nativeElement.focus();
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
  setSection(id: string) {
    this.state.section.set(id);
    this.navigationOpen.set(false);
  }
  browseCollections() {
    this.state.section.set('collections');
    this.navigationOpen.set(true);
  }
  closeNavigation() {
    this.navigationOpen.set(false);
    if (this.appearance.current() === 'canvas' && this.state.section() === 'history') {
      this.state.section.set('collections');
    }
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
  /** Closes an actions menu after one of its buttons is used, or after a click outside it. */
  @HostListener('click', ['$event']) protected closeMenu(event: Event) {
    this.menus.clicked(event);
  }
  /** Resizing and Escape close the floating menus. */
  @HostListener('window:resize')
  @HostListener('document:keydown.escape')
  protected closeMenus() {
    this.menus.close();
  }
  dialogTitle() {
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
  async submitDialog() {
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
  async file(event: Event) {
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
  search(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.state.filter.set(value);
    this.formModel.update((model) => ({ ...model, search: value }));
  }
  duplicate(document: WorkspaceDocument) {
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
  folder(document: WorkspaceDocument, path: number[] = []) {
    this.dialogTarget.set({ document, path });
    this.formModel.update((m) => ({ ...m, name: '' }));
    this.dialogs.set('folder');
  }
  rename(document: WorkspaceDocument, path: number[], name: string) {
    this.dialogTarget.set({ document, path });
    this.formModel.update((m) => ({ ...m, name }));
    this.dialogs.set('rename');
  }
}
