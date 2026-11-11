import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { REPORTS, WORKSPACE } from '../composition/providers';
import { Report } from '../application/report-use-cases';
import {
  CollectionItem,
  KeyValue,
  RequestDraft,
  Run,
  WorkspaceDocument,
  asCollection,
  newRequest,
} from '../domain/models';
import { GraphQLSchema, graphqlEndpoint } from '../domain/graphql-schema';
import { DropPosition, dropPlace, isWithin, itemAt, staysInPlace } from '../domain/collection-tree';
import { CookieChange, CookieKey, StoredCookie, cookieKey, sameCookie } from '../domain/cookies';
import {
  RequestAncestor,
  ResolvedVariable,
  VariableRow,
  VariableScopes,
  inheritedCollectionVariables,
  requestVariables,
  resolveVariable,
} from '../domain/variables';
import {
  AuthDraft,
  OAuth2SignIn,
  OAuth2SignInStatus,
  OAuth2Token,
  autoFetches,
  needsSignIn,
  oauth2UsesBrowser,
  writeAuth,
} from '../domain/auth';
import {
  ExecutionContext,
  PastedOAuth2Token,
  WorkspaceExecuteArgs,
} from '../application/workspace-use-cases';
import { TabsStore } from './tabs-store';

import { CollectionsStore } from './state/collections-store';
import { DocumentsStore } from './state/documents-store';
import { RequestsStore } from './state/requests-store';
import { SessionStore } from './state/session-store';
import { StateContext, StatusStore, Toast, named, success } from './state/state-context';
import { VariablesStore } from './state/variables-store';

export { TOAST_DURATION, named, success } from './state/state-context';
export type { Toast } from './state/state-context';
/** Where an obtained token was kept: in the stored authorization, only in the tab, or only
 * in the vault. */
export type KeptToken = 'saved' | 'unsaved' | 'vault';

export type SettingsTab = 'variables' | 'authorization' | 'scripts';

/** Variables not saved because they changed elsewhere and the person kept that version. */
const variablesReloaded: Toast = {
  kind: 'info',
  title: 'Variables not saved',
  message: 'They changed elsewhere and were reloaded with the latest values.',
};
/** What saving variables gave: the document saved, or nothing when the person kept the
 * version changed elsewhere. `undefined` when it failed. */
export type VariablesSave = { saved?: WorkspaceDocument } | undefined;

/**
 * The workspace seen by the components. Each concern lives in its own store
 * (`state/`); this facade wires them together and keeps the names templates use.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceState {
  readonly cases = inject(WORKSPACE);
  private readonly i18n = inject(TranslocoService);
  /** Asks the user to confirm a destructive action; replaced in tests. */
  confirm: (message: string) => boolean = (message) =>
    typeof globalThis.confirm === 'function'
      ? globalThis.confirm(this.i18n.translate(message))
      : true;

  readonly workspaceId = signal('');
  readonly section = signal('collections');
  /** Sections left to reach the current one, most recent last, for "Back". */
  private readonly trail = signal<string[]>([]);
  /** Where "Back" returns to, or nothing at the first section. */
  readonly backSection = computed(() => this.trail().at(-1) ?? '');
  private shownSection = this.section();
  private returning = false;
  private readonly followSections = effect(() => {
    const now = this.section();
    untracked(() => {
      if (now === this.shownSection) return;
      if (this.returning) this.returning = false;
      else
        this.trail.update((trail) =>
          [...trail.filter((x) => x !== now), this.shownSection].slice(-20),
        );
      this.shownSection = now;
    });
  });
  /** Returns to the section shown before this one, as a browser's back button. */
  goBack() {
    const trail = this.trail();
    const previous = trail.at(-1);
    if (!previous) return;
    this.returning = true;
    this.trail.set(trail.slice(0, -1));
    this.section.set(previous);
  }
  readonly consoleOpen = signal(false);
  /** Collection whose variables, auth and scripts are edited in the collection settings view. */
  readonly settingsCollectionId = signal('');
  /** Folder of that collection being edited; empty for the collection itself. */
  readonly settingsPath = signal<number[]>([]);
  readonly settingsTab = signal<SettingsTab>('variables');

  private readonly status = new StatusStore();
  readonly tabsStore = new TabsStore(() => this.cases.files.id());
  private readonly context: StateContext = {
    cases: this.cases,
    status: this.status,
    tabs: this.tabsStore,
    workspaceId: this.workspaceId,
    section: this.section,
    confirm: (message) => this.confirm(message),
  };
  private readonly store = new DocumentsStore(this.context);
  private readonly variableStore = new VariablesStore(this.context, this.store);
  private readonly collectionStore = new CollectionsStore(this.context, this.store);
  private readonly requests = new RequestsStore(
    this.context,
    this.store,
    this.variableStore,
    this.collectionStore,
  );
  private readonly session = new SessionStore(this.context, this.store, this.variableStore);

  // Feedback.
  readonly error = this.status.error;
  readonly notice = this.status.notice;
  readonly busy = this.status.busy;
  readonly running = this.requests.running;
  // Session.
  readonly ready = this.session.ready;
  readonly health = this.session.health;
  readonly authenticated = this.session.authenticated;
  readonly workspaces = this.session.workspaces;
  // Documents and variables.
  readonly documents = this.store.documents;
  readonly collections = this.store.collections;
  readonly environments = this.store.environments;
  readonly history = this.store.history;
  readonly globalsDocument = this.store.globalsDocument;
  readonly environmentId = this.variableStore.environmentId;
  readonly environmentDocument = this.variableStore.environmentDocument;
  readonly environmentRows = this.variableStore.environmentRows;
  readonly globalRows = this.variableStore.globalRows;
  readonly variables = this.variableStore.variables;
  // Tabs and collections.
  readonly tabs = this.tabsStore.tabs;
  readonly activeTabId = this.tabsStore.activeId;
  readonly response = this.tabsStore.response;
  readonly active = this.tabsStore.active;
  readonly filter = this.collectionStore.filter;
  readonly trees = this.collectionStore.trees;
  readonly activeCollection = this.collectionStore.activeCollection;
  readonly activeAncestors = this.collectionStore.activeAncestors;
  readonly activeInheritance = this.collectionStore.activeInheritance;
  readonly scopes = computed<VariableScopes>(() => ({
    environment: this.environmentRows(),
    collection: inheritedCollectionVariables(this.activeAncestors()),
    globals: this.globalRows(),
  }));
  /** Every `{{variable}}` the active request uses and where its value comes from. */
  readonly activeVariables = computed<ResolvedVariable[]>(() => {
    const tab = this.active();
    if (!tab) return [];
    const scopes = this.scopes();
    return requestVariables(tab.request).map((name) => resolveVariable(name, scopes));
  });

  guard(action: () => Promise<unknown>) {
    return this.status.guard(action);
  }
  /**
   * Runs an action that stores, deletes or downloads something and says in a toast how it
   * went: what it did, why it did nothing, or why it failed. Returns whether it did not fail.
   */
  announce(failure: string, action: () => Promise<Toast | undefined>) {
    return this.status.announce(failure, action);
  }
  /**
   * Downloads a file and says so in a toast. The browser saves it in its downloads folder, or
   * asks where; Nexo cannot know which, nor when it ends. `content` may be prepared on the
   * way, so a failure to prepare it is told too.
   */
  download(name: string, content: string | Blob | (() => Blob), type?: string) {
    return this.announce('The file could not be downloaded', async () => {
      this.cases.files.download(name, typeof content === 'function' ? content() : content, type);
      return success('File downloaded', 'toast.downloaded', { v0: name });
    });
  }
  describe(error: unknown) {
    return this.status.describe(error);
  }
  /** Runs an engine operation inside the current workspace. */
  execute<T>(...args: WorkspaceExecuteArgs): Promise<T> {
    return this.cases.execute<T>(this.workspaceId(), ...args);
  }

  // Session and workspaces.
  initialize() {
    return this.guard(() => this.session.initialize());
  }
  signOut() {
    return this.guard(() => this.session.signOut());
  }
  createWorkspace(name: string) {
    return this.announce('The workspace could not be created', async () =>
      named('Workspace created', (await this.session.create(name)).name),
    );
  }
  renameWorkspace(name: string) {
    return this.announce('The workspace could not be renamed', async () => {
      await this.session.rename(name);
      return named('Workspace renamed', name.trim());
    });
  }
  deleteWorkspace() {
    const name = this.workspaces().find((w) => w.id === this.workspaceId())?.name ?? '';
    return this.announce('The workspace could not be deleted', async () =>
      (await this.session.remove()) ? named('Workspace deleted', name) : undefined,
    );
  }
  selectWorkspace(id: string) {
    return this.session.select(id);
  }
  /** Opens a workspace created outside the workspace menu, such as a cloned repository. */
  openWorkspace(id: string) {
    return this.session.open(id);
  }
  /** Shows documents a panel saved, without reloading the workspace. */
  applySaved(saved: WorkspaceDocument[]) {
    this.store.applySaved(saved);
  }
  /** Stops showing a document a panel deleted. */
  forget(document: WorkspaceDocument) {
    this.store.forget(document);
  }
  async refresh() {
    await this.store.refresh();
    this.variableStore.validate();
  }

  // Tabs.
  newTab(request?: RequestDraft, documentId = '', path: number[] = []) {
    this.tabsStore.open(request, documentId, path);
    this.section.set('collections');
  }
  closeTab(id: string) {
    const tab = this.tabs().find((t) => t.id === id);
    if (tab?.dirty && !this.confirm('Discard unsaved changes in this request?')) return;
    this.tabsStore.close(id);
    if (!this.tabs().length) this.newTab();
  }
  edit(request: RequestDraft) {
    this.tabsStore.edit(request);
  }

  // Collections.
  openItem(document: WorkspaceDocument, item: CollectionItem, path: number[]) {
    this.collectionStore.open(document, item, path);
  }
  collectionItems(document: WorkspaceDocument) {
    return this.collectionStore.rows(document);
  }
  createCollection(name: string) {
    return this.announce('The collection could not be created', async () =>
      named('Collection created', (await this.store.createCollection(name)).name),
    );
  }
  addRequest(document: WorkspaceDocument, folderPath: number[] = []) {
    return this.announce('The collection could not be saved', async () => {
      await this.collectionStore.addRequest(document, folderPath);
      return success('Request added', 'toast.itemIn', { v0: 'New request', v1: document.name });
    });
  }
  /**
   * Saves a change to the tree of a collection and says which item it changed, by the name it
   * has after the change.
   */
  private changeTree(
    document: WorkspaceDocument,
    done: string,
    name: string,
    change: Parameters<CollectionsStore['change']>[1],
  ) {
    return this.announce('The collection could not be saved', async () => {
      await this.collectionStore.change(document, change);
      return success(done, 'toast.itemIn', { v0: name, v1: document.name });
    });
  }
  /** The name of an item of a collection, as it is now. */
  private itemName(document: WorkspaceDocument, path: readonly number[]) {
    try {
      return itemAt(asCollection(document.value), path)?.name ?? '';
    } catch {
      return '';
    }
  }
  addFolder(document: WorkspaceDocument, name: string, parent: number[] = []) {
    return this.changeTree(document, 'Folder added', name.trim(), (tree, collection) =>
      tree.addFolder(collection, parent, name, this.cases.files.id()),
    );
  }
  renameItem(document: WorkspaceDocument, path: number[], name: string) {
    return this.changeTree(document, 'Item renamed', name.trim(), (tree, collection) =>
      tree.renameItem(collection, path, name),
    );
  }
  async removeItem(document: WorkspaceDocument, path: number[]) {
    if (!this.confirm('Delete this item and everything inside it?')) return false;
    return this.changeTree(
      document,
      'Item deleted',
      this.itemName(document, path),
      (tree, collection) => tree.removeItem(collection, path),
    );
  }
  reorderItem(document: WorkspaceDocument, path: number[], offset: -1 | 1) {
    return this.changeTree(
      document,
      'Item moved',
      this.itemName(document, path),
      (tree, collection) => tree.reorderItem(collection, path, offset),
    );
  }
  moveItem(document: WorkspaceDocument, path: number[], folder: number[]) {
    return this.changeTree(
      document,
      'Item moved',
      this.itemName(document, path),
      (tree, collection) => tree.moveInto(collection, path, folder),
    );
  }
  /**
   * Moves an item dropped before, after or inside another one. A folder dropped into itself
   * stays and the reason is announced; so is the move.
   */
  async dropItem(
    document: WorkspaceDocument,
    path: number[],
    over: number[],
    position: DropPosition,
  ) {
    const { folder, index } = dropPlace(over, position);
    if (isWithin(folder, path)) {
      this.tell({ kind: 'info', title: 'A folder cannot be moved into itself' });
      return false;
    }
    if (staysInPlace(path, folder, index)) return true;
    return this.changeTree(
      document,
      'Item moved',
      this.itemName(document, path),
      (tree, collection) => tree.moveTo(collection, path, folder, index),
    );
  }
  /** Saves the active request (Ctrl+S) and says in a toast whether, and where, it was saved. */
  saveActive(targetDocumentId?: string) {
    return this.announce('The request could not be saved', () =>
      this.collectionStore.saveActive(targetDocumentId),
    );
  }
  /** Opens the settings of a collection or, with a path, of one of its folders. */
  openCollectionSettings(id: string, path: number[] = [], tab: SettingsTab = 'variables') {
    this.settingsCollectionId.set(id);
    this.settingsPath.set(path);
    this.settingsTab.set(tab);
    this.section.set('collection-settings');
  }
  /** Opens the folder or collection that the active request takes its authorization from. */
  editInheritedAuth() {
    const document = this.activeCollection();
    if (!document) return;
    const path = this.activeInheritance()?.source?.path ?? [];
    this.openCollectionSettings(document.id, path, 'authorization');
  }
  /** A message that closes by itself after 20 seconds, or with its button. */
  readonly toast = this.status.toast;
  showToast(toast: Toast) {
    this.status.showToast(toast);
  }
  closeToast() {
    this.status.closeToast();
  }
  /** Says something in a toast, and keeps its title in the status bar. */
  tell(toast: Toast) {
    this.status.tell(toast);
  }
  /**
   * Stores an authorization where it is defined (a request, a folder or the collection, `[]`)
   * and nothing else of that collection, such as a token just obtained.
   */
  async keepAuth(documentId: string, path: number[], auth: AuthDraft) {
    const document = this.collections().find((d) => d.id === documentId);
    if (!document) throw new Error('Collection not found');
    await this.collectionStore.change(document, (tree, collection) =>
      tree.withStoredAuth(collection, path, auth),
    );
  }
  /**
   * Shows the new authorization of a request in its tab and stores it in its collection; the
   * rest of the tab's unsaved changes stay unsaved. A request outside a collection can only
   * be saved by the person.
   */
  async keepRequestAuth(tabId: string, auth: AuthDraft): Promise<KeptToken> {
    const tab = this.tabs().find((t) => t.id === tabId);
    if (!tab) return 'vault';
    const document = this.collections().find((d) => d.id === tab.documentId);
    const stored = !!document && tab.path.length > 0;
    this.tabsStore.tabs.update((tabs) =>
      tabs.map((t) =>
        t.id === tabId ? { ...t, request: { ...t.request, auth }, dirty: t.dirty || !stored } : t,
      ),
    );
    if (!stored) return 'unsaved';
    await this.keepAuth(document.id, tab.path, auth);
    return 'saved';
  }
  /**
   * Obtains (or with `refresh`, renews) an OAuth 2.0 token for an authorization edited in a
   * request, folder or collection, resolving variables in the scopes of `ancestors`. `keep`
   * stores it in that authorization. A toast says how it went: obtained and saved, failed, or
   * cancelled.
   */
  async oauth2Token(
    auth: AuthDraft,
    ancestors: readonly RequestAncestor[],
    refresh: boolean,
    keep?: (token: OAuth2Token) => Promise<KeptToken>,
  ): Promise<OAuth2Token | undefined> {
    let token: OAuth2Token | undefined;
    await this.guard(async () => {
      const context = {
        workspace: this.workspaceId(),
        environment: this.environmentRows(),
        globals: this.globalRows(),
        ancestors,
      };
      if (!refresh && oauth2UsesBrowser(auth)) {
        this.oauth2SignInName = String(auth.values['tokenName'] ?? '');
        token = await this.signIn(writeAuth(auth), context);
      } else {
        const tokenId = refresh ? String(auth.values['oauth2TokenId'] ?? '') : undefined;
        if (refresh && !tokenId) throw new Error('There is no refresh token to use');
        token = await this.cases.oauth2Token(writeAuth(auth), context, tokenId);
      }
      if (token) {
        this.notice.set(refresh ? 'Access token refreshed' : 'Access token obtained');
        this.oauth2Tokens.set(await this.cases.oauth2Tokens(this.workspaceId()));
      }
    });
    if (!token) {
      const failure = this.error();
      if (failure) {
        // Said in the toast, not twice.
        this.error.set('');
        this.showToast({
          kind: 'error',
          title: refresh
            ? 'The access token could not be refreshed'
            : 'The access token could not be obtained',
          detail: failure,
        });
      } else {
        this.showToast({
          kind: 'info',
          title: 'Sign-in cancelled',
          message: 'No access token was obtained.',
        });
      }
      return undefined;
    }
    let kept: KeptToken = 'vault';
    if (keep) {
      try {
        kept = await keep(token);
      } catch (error) {
        this.showToast({
          kind: 'error',
          title: refresh ? 'Access token refreshed' : 'Access token obtained',
          message: 'It is in your vault, but the authorization could not be saved.',
          detail: this.describe(error),
        });
        return token;
      }
    }
    this.showToast({
      kind: 'success',
      title: refresh ? 'Access token refreshed' : 'Access token obtained',
      message: {
        saved: 'oauth2.keptSaved',
        unsaved: 'oauth2.keptUnsaved',
        vault: 'oauth2.keptVault',
      }[kept],
      params: { v0: token.name },
    });
    return token;
  }
  /** Stored OAuth 2.0 tokens: Postman's "Available Tokens". */
  readonly oauth2Tokens = signal<OAuth2Token[]>([]);
  /** Whether the "Manage Tokens" dialog is open. */
  readonly managingOAuth2Tokens = signal(false);
  async loadOAuth2Tokens() {
    try {
      this.oauth2Tokens.set(await this.cases.oauth2Tokens(this.workspaceId()));
    } catch {
      // The list stays as it was; the editors still work with custom tokens.
    }
  }
  oauth2TokenDetails(id: string) {
    return this.cases.oauth2TokenDetails(this.workspaceId(), id);
  }
  deleteOAuth2Token(id: string) {
    const name = this.oauth2Tokens().find((token) => token.id === id)?.name ?? '';
    return this.announce('The token could not be deleted', async () => {
      await this.cases.deleteOAuth2Token(this.workspaceId(), id);
      this.oauth2Tokens.update((tokens) => tokens.filter((token) => token.id !== id));
      return named('Token deleted', name);
    });
  }
  /** Printable reports, and the one shown before printing it or saving it as PDF. */
  readonly reports = inject(REPORTS);
  readonly report = signal<Report | undefined>(undefined);
  /** The request of the active tab with its response. */
  reportRequest() {
    const tab = this.active();
    const response = this.response();
    if (tab && response) this.report.set(this.reports.requestReport(tab.request, response));
  }
  /** The documentation of a collection. */
  reportCollection(id: string) {
    const document = this.collections().find((d) => d.id === id);
    if (!document) return;
    try {
      this.report.set(this.reports.collectionDocs(document));
    } catch (error) {
      this.error.set(this.describe(error));
    }
  }
  closeReport() {
    this.report.set(undefined);
    this.reports.release();
  }
  /** The cookies of the workspace jar, for Postman's "Manage Cookies". */
  readonly cookies = signal<StoredCookie[]>([]);
  /** Whether the "Manage Cookies" dialog is open. */
  readonly managingCookies = signal(false);
  /** Opens "Manage Cookies" with the cookies the jar has now. */
  manageCookies() {
    this.managingCookies.set(true);
    return this.loadCookies();
  }
  loadCookies() {
    return this.guard(async () => this.cookies.set(await this.cases.cookies(this.workspaceId())));
  }
  /** Saves a new or edited cookie; returns whether it was saved. */
  saveCookie(change: CookieChange, original?: CookieKey) {
    return this.announce('The cookie could not be saved', async () => {
      const cookie = await this.cases.setCookie(this.workspaceId(), change, original);
      const replaced = (other: StoredCookie) =>
        sameCookie(cookieKey(other), cookieKey(cookie)) ||
        (!!original && sameCookie(cookieKey(other), original));
      this.cookies.update((cookies) => [...cookies.filter((other) => !replaced(other)), cookie]);
      return success('Cookie saved', 'toast.cookie', { v0: cookie.name, v1: cookie.domain });
    });
  }
  deleteCookie(key: CookieKey) {
    return this.announce('The cookie could not be deleted', async () => {
      await this.cases.deleteCookie(this.workspaceId(), key);
      this.cookies.update((cookies) =>
        cookies.filter((cookie) => !sameCookie(cookieKey(cookie), key)),
      );
      return success('Cookie deleted', 'toast.cookie', { v0: key.name, v1: key.domain });
    });
  }
  /** Deletes every cookie of a domain, or of the whole jar without one. */
  clearCookies(domain?: string) {
    return this.announce('The cookies could not be deleted', async () => {
      const workspace = this.workspaceId();
      if (domain === undefined) {
        await this.cases.clearCookies(workspace);
        this.cookies.set([]);
        return success('Cookies deleted');
      }
      for (const cookie of this.cookies().filter((c) => c.domain === domain))
        await this.cases.deleteCookie(workspace, cookieKey(cookie));
      this.cookies.update((cookies) => cookies.filter((c) => c.domain !== domain));
      return named('Cookies deleted', domain);
    });
  }
  /** The browser sign-in in progress, shown in a dialog until it finishes. */
  readonly oauth2SignIn = signal<OAuth2SignIn | undefined>(undefined);
  /** Status returned by pasting the address, read by the polling loop. */
  private oauth2Completed?: OAuth2SignInStatus;
  /** Token name of the sign-in in progress, for a token pasted by hand. */
  private oauth2SignInName = '';
  /** Runs a browser sign-in until it gives a token, fails or is cancelled (`undefined`). */
  private async signIn(auth: unknown, context: ExecutionContext) {
    const started = await this.cases.oauth2Authorize(auth, context);
    // The desktop app shows the page in its own window, like Postman's built-in browser, and
    // takes the Callback URL from it. "Authorize using browser" keeps the system browser.
    const inWindow = this.cases.hasSignInWindow && started.mode !== 'relay';
    this.oauth2Completed = undefined;
    this.oauth2SignIn.set({ ...started, window: inWindow, opened: started.opened || inWindow });
    if (inWindow) this.watchSignInWindow(started);
    else if (this.cases.hasSignInWindow)
      await this.cases.oauth2SignIn(this.workspaceId(), started.session, 'open');
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (this.oauth2SignIn()?.session !== started.session) return undefined;
        const status =
          this.oauth2Completed ??
          (await this.cases.oauth2SignIn(this.workspaceId(), started.session, 'status'));
        this.oauth2Completed = undefined;
        if (status.state === 'done') return status.token;
        if (status.state === 'error') throw new Error(status.error ?? 'The sign-in failed');
        if (status.state === 'cancelled') return undefined;
      }
    } finally {
      if (this.oauth2SignIn()?.session === started.session) this.oauth2SignIn.set(undefined);
      if (inWindow) void this.cases.closeSignInWindow().catch(() => {});
    }
  }
  /** Takes the address from the sign-in window; closing the window cancels the sign-in. */
  private watchSignInWindow(signIn: OAuth2SignIn) {
    const current = () => this.oauth2SignIn()?.session === signIn.session;
    this.cases
      .openSignInWindow(signIn)
      .then(async (ended) => {
        if (!current()) return;
        if (ended.outcome === 'returned') await this.completeOAuth2SignIn(ended.url);
        else if (ended.outcome === 'closed') await this.cancelOAuth2SignIn();
      })
      .catch((error: unknown) => {
        if (current()) this.error.set(this.describe(error));
      });
  }
  /** Manual mode: the address the browser returned to. */
  async completeOAuth2SignIn(url: string) {
    const signIn = this.oauth2SignIn();
    if (!signIn) return;
    try {
      this.oauth2Completed = await this.cases.oauth2SignIn(
        this.workspaceId(),
        signIn.session,
        'complete',
        url.trim(),
      );
    } catch (error) {
      this.error.set(this.describe(error));
    }
  }
  /**
   * Ends the sign-in with a token the person pasted from the browser, when the address it
   * returned to carries no code (a web front that signs in by itself and cleans its address).
   */
  async useOAuth2Token(pasted: PastedOAuth2Token) {
    const signIn = this.oauth2SignIn();
    if (!signIn) return;
    try {
      const token = await this.cases.addOAuth2Token(
        this.workspaceId(),
        this.oauth2SignInName,
        pasted,
      );
      this.oauth2Completed = { state: 'done', token };
      void this.cases.oauth2SignIn(this.workspaceId(), signIn.session, 'cancel').catch(() => {});
    } catch (error) {
      this.error.set(this.describe(error));
    }
  }
  async reopenOAuth2SignIn() {
    const signIn = this.oauth2SignIn();
    if (signIn?.window) this.watchSignInWindow(signIn);
    else if (signIn) await this.cases.oauth2SignIn(this.workspaceId(), signIn.session, 'open');
  }
  async cancelOAuth2SignIn() {
    const signIn = this.oauth2SignIn();
    if (!signIn) return;
    this.oauth2SignIn.set(undefined);
    await this.cases.oauth2SignIn(this.workspaceId(), signIn.session, 'cancel').catch(() => {});
  }
  /** Saves the variables, authorization and scripts of a collection or folder. */
  saveCollectionSettings(
    id: string,
    settings: { variables: readonly VariableRow[]; auth?: unknown; event?: unknown },
    folder: number[] = [],
  ) {
    const document = this.collections().find((d) => d.id === id);
    return this.announce(
      folder.length ? 'The folder could not be saved' : 'The collection could not be saved',
      async () => {
        await this.store.saveCollectionSettings(id, settings, folder);
        return folder.length && document
          ? success('Folder saved', 'toast.itemIn', {
              v0: this.itemName(document, folder),
              v1: document.name,
            })
          : named('Collection saved', document?.name ?? '');
      },
    );
  }

  // Requests and history.
  async send() {
    await this.signInBeforeSending();
    return this.requests.send();
  }
  /**
   * Bruno's "Auto-fetch token" for grants that sign in through a browser: without a usable
   * token, the sign-in runs first and stores one under the token name, which the engine then
   * uses. Grants without a browser are fetched by the engine itself.
   */
  private async signInBeforeSending() {
    const request = this.active()?.request;
    if (!request) return;
    const auth =
      request.auth.type === 'inherit' ? this.activeInheritance()?.source?.auth : request.auth;
    if (auth?.type !== 'oauth2' || !autoFetches(auth) || !oauth2UsesBrowser(auth)) return;
    await this.loadOAuth2Tokens();
    if (needsSignIn(auth, this.oauth2Tokens(), Date.now()))
      await this.oauth2Token(auth, this.activeAncestors(), false);
  }
  cancel() {
    return this.guard(() => this.requests.cancel());
  }

  // GraphQL schemas, by endpoint URL. As in Postman, they are loaded again in each session
  // rather than saved in the collection.
  readonly graphqlSchemas = signal<Readonly<Record<string, GraphQLSchema>>>({});
  readonly loadingSchema = signal(false);
  /** The schema loaded for an endpoint, whether written with http(s) or ws(s). */
  schemaFor(url: string): GraphQLSchema | undefined {
    return this.graphqlSchemas()[graphqlEndpoint(url)];
  }
  /** Loads the schema of the active request's endpoint by introspection. */
  async loadGraphqlSchema() {
    const request = this.active()?.request;
    if (!request) return;
    await this.introspect(request, this.activeAncestors());
  }
  /**
   * Loads the schema of a subscription endpoint, over HTTP at the same address, with the
   * connection's headers, such as its authorization.
   */
  loadEndpointSchema(url: string, headers: readonly KeyValue[]) {
    return this.introspect(
      {
        ...newRequest(this.cases.files.id()),
        protocol: 'graphql',
        url: graphqlEndpoint(url),
        headers: headers.filter((row) => row.enabled && row.key).map((row) => ({ ...row })),
      },
      [],
    );
  }
  private async introspect(request: RequestDraft, ancestors: readonly RequestAncestor[]) {
    if (this.loadingSchema()) return;
    this.loadingSchema.set(true);
    try {
      await this.guard(async () => {
        const schema = await this.cases.introspect(
          request,
          {
            workspace: this.workspaceId(),
            environment: this.environmentRows(),
            globals: this.globalRows(),
            ancestors,
          },
          this.cases.files.id(),
        );
        this.graphqlSchemas.update((schemas) => ({
          ...schemas,
          [graphqlEndpoint(request.url)]: schema,
        }));
        this.notice.set('Schema loaded');
      });
    } finally {
      this.loadingSchema.set(false);
    }
  }
  openHistory(document: WorkspaceDocument) {
    return this.guard(() => this.requests.openHistory(document));
  }
  recordRun(run: Run, collectionId: string) {
    return this.requests.recordRun(run, collectionId);
  }

  // Documents and variables.
  importContent(content: string) {
    return this.announce('The import failed', async () => {
      const created = await this.store.importContent(content);
      this.variableStore.validate();
      return named('Import completed', created.name);
    });
  }
  /** Downloads a collection or environment as JSON, and says so. */
  export(document: WorkspaceDocument) {
    return this.announce('The file could not be downloaded', async () =>
      success('File downloaded', 'toast.downloaded', { v0: this.cases.export(document) }),
    );
  }
  remove(document: WorkspaceDocument) {
    return this.announce('It could not be deleted', async () => {
      await this.store.remove(document);
      if (this.environmentId() === document.id) this.selectEnvironment('');
      return named('Deleted', document.name);
    });
  }
  selectEnvironment(id: string) {
    this.variableStore.select(id);
  }
  /** Tells that the person kept variables changed elsewhere instead of saving theirs. */
  variablesReloaded() {
    this.tell(variablesReloaded);
  }
  async saveEnvironment(
    id: string,
    name: string,
    rows: readonly VariableRow[],
  ): Promise<VariablesSave> {
    let saved: WorkspaceDocument | undefined;
    const ok = await this.announce('The environment could not be saved', async () => {
      saved = await this.variableStore.saveEnvironment(id, name, rows);
      return saved ? named('Environment saved', saved.name) : variablesReloaded;
    });
    return ok ? { saved } : undefined;
  }
  async saveGlobals(rows: readonly VariableRow[]): Promise<VariablesSave> {
    let saved: WorkspaceDocument | undefined;
    const ok = await this.announce('The global variables could not be saved', async () => {
      saved = await this.variableStore.saveGlobals(rows);
      return saved ? success('Global variables saved') : variablesReloaded;
    });
    return ok ? { saved } : undefined;
  }
}
