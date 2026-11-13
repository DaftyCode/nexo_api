import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { REPORTS, WORKSPACE } from '../composition/providers';
import { RequestDraft, Run, WorkspaceDocument } from '../domain/models';
import {
  ResolvedVariable,
  VariableRow,
  VariableScopes,
  inheritedCollectionVariables,
  requestVariables,
  resolveVariable,
} from '../domain/variables';
import { PastedOAuth2Token, WorkspaceExecuteArgs } from '../application/workspace-use-cases';
import { TabsStore } from './tabs-store';

import { CollectionsStore } from './state/collections-store';
import { DocumentsStore } from './state/documents-store';
import { RequestsStore } from './state/requests-store';
import { SessionStore } from './state/session-store';
import { StateContext, StatusStore, Toast } from './state/state-context';
import { VariablesStore } from './state/variables-store';
import { CookiesStore } from './state/cookies-store';
import { OAuth2Store } from './state/oauth2-store';
import { SchemasStore } from './state/schemas-store';
import { TreeStore } from './state/tree-store';
import { NavigationStore } from './state/navigation-store';
import { ReportsStore } from './state/reports-store';
import { SavesStore } from './state/saves-store';
import { WorkspaceSessionStore } from './state/workspace-session-store';

export { TOAST_DURATION, named, success } from './state/state-context';
export type { Toast } from './state/state-context';
export type { KeptToken } from './state/oauth2-store';

export type { SettingsTab } from './state/navigation-store';
export type { VariablesSave } from './state/saves-store';

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
  private readonly navigation = new NavigationStore();
  readonly section = this.navigation.section;
  readonly backSection = this.navigation.backSection;
  /** Returns to the section shown before this one, as a browser's back button. */
  goBack = () => this.navigation.goBack();
  readonly consoleOpen = this.navigation.consoleOpen;
  readonly settingsCollectionId = this.navigation.settingsCollectionId;
  readonly settingsPath = this.navigation.settingsPath;
  readonly settingsTab = this.navigation.settingsTab;

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
  /** Tabs, section and collection order, reopened with each workspace and saved as they change. */
  private readonly opened = new WorkspaceSessionStore(this.context, this.store);
  private readonly session = new SessionStore(
    this.context,
    this.store,
    this.variableStore,
    this.opened,
  );
  private readonly tree = new TreeStore(this.context, this.store, this.collectionStore);
  private readonly oauth2Store = new OAuth2Store(this, this.collectionStore);
  private readonly cookieStore = new CookiesStore(this.context);
  private readonly schemaStore = new SchemasStore(this);
  private readonly reportStore = new ReportsStore(inject(REPORTS), this);
  private readonly saves = new SavesStore(
    this.context,
    this.store,
    this.variableStore,
    this.session,
  );

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

  constructor() {
    effect(() => this.opened.changed());
    globalThis.addEventListener?.('pagehide', () => void this.opened.flush());
  }

  guard = (action: () => Promise<unknown>) => this.status.guard(action);
  /**
   * Runs an action that stores, deletes or downloads something and says in a toast how it
   * went: what it did, why it did nothing, or why it failed. Returns whether it did not fail.
   */
  announce: StatusStore['announce'] = (...args) => this.status.announce(...args);
  /** Downloads a file and says so in a toast. */
  download: SavesStore['download'] = (...args) => this.saves.download(...args);
  describe = (error: unknown) => this.status.describe(error);
  /** Runs an engine operation inside the current workspace. */
  execute<T>(...args: WorkspaceExecuteArgs): Promise<T> {
    return this.cases.execute<T>(this.workspaceId(), ...args);
  }

  // Session and workspaces.
  initialize = () => this.guard(() => this.session.initialize());
  signOut = () => this.guard(() => this.session.signOut());
  createWorkspace = (name: string) => this.saves.createWorkspace(name);
  renameWorkspace = (name: string) => this.saves.renameWorkspace(name);
  deleteWorkspace = () => this.saves.deleteWorkspace();
  selectWorkspace = (id: string) => this.session.select(id);
  /** Opens a workspace created outside the workspace menu, such as a cloned repository. */
  openWorkspace = (id: string) => this.session.open(id);
  /** Shows documents a panel saved, without reloading the workspace. */
  applySaved = (saved: WorkspaceDocument[]) => this.store.applySaved(saved);
  /** Stops showing a document a panel deleted. */
  forget = (document: WorkspaceDocument) => this.store.forget(document);
  async refresh() {
    await this.store.refresh();
    this.variableStore.validate();
  }

  // Tabs.
  readonly restoresTabs = this.opened.restoresTabs;
  setRestoresTabs = (restore: boolean) => this.opened.setRestoresTabs(restore);
  moveTab = (id: string, to: number) => this.tabsStore.move(id, to);
  moveActiveTab = (offset: -1 | 1) => this.tabsStore.moveActive(offset);
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
  edit = (request: RequestDraft) => this.tabsStore.edit(request);

  // Collections.
  openItem: CollectionsStore['open'] = (...args) => this.collectionStore.open(...args);
  collectionItems = (document: WorkspaceDocument) => this.collectionStore.rows(document);
  createCollection = (name: string) => this.saves.createCollection(name);
  moveCollection = (id: string, to: number) => this.opened.moveCollection(id, to);
  addRequest: TreeStore['addRequest'] = (...args) => this.tree.addRequest(...args);
  // Collection trees.
  addFolder: TreeStore['addFolder'] = (...args) => this.tree.addFolder(...args);
  renameItem: TreeStore['renameItem'] = (...args) => this.tree.renameItem(...args);
  removeItem: TreeStore['removeItem'] = (...args) => this.tree.removeItem(...args);
  reorderItem: TreeStore['reorderItem'] = (...args) => this.tree.reorderItem(...args);
  moveItem: TreeStore['moveItem'] = (...args) => this.tree.moveItem(...args);
  /** Moves an item dropped before, after or inside another one. */
  dropItem: TreeStore['dropItem'] = (...args) => this.tree.dropItem(...args);
  /** Saves the variables, authorization and scripts of a collection or folder. */
  saveCollectionSettings: TreeStore['saveSettings'] = (...args) => this.tree.saveSettings(...args);
  /** Saves the active request (Ctrl+S) and says in a toast whether, and where, it was saved. */
  saveActive = (targetDocumentId?: string) => this.tree.saveActive(targetDocumentId);
  /** Opens the settings of a collection or, with a path, of one of its folders. */
  openCollectionSettings: NavigationStore['openSettings'] = (...args) =>
    this.navigation.openSettings(...args);
  /** Opens the folder or collection that the active request takes its authorization from. */
  editInheritedAuth() {
    const document = this.activeCollection();
    if (!document) return;
    const path = this.activeInheritance()?.source?.path ?? [];
    this.openCollectionSettings(document.id, path, 'authorization');
  }
  /** A message that closes by itself after 20 seconds, or with its button. */
  readonly toast = this.status.toast;
  showToast = (toast: Toast) => this.status.showToast(toast);
  closeToast = () => this.status.closeToast();
  /** Says something in a toast, and keeps its title in the status bar. */
  tell = (toast: Toast) => this.status.tell(toast);
  // OAuth 2.0 tokens.
  keepAuth: OAuth2Store['keepAuth'] = (...args) => this.oauth2Store.keepAuth(...args);
  keepRequestAuth: OAuth2Store['keepRequestAuth'] = (...args) =>
    this.oauth2Store.keepRequestAuth(...args);
  /** Obtains or renews a token, and says in a toast how it went. */
  oauth2Token: OAuth2Store['token'] = (...args) => this.oauth2Store.token(...args);
  /** Stored OAuth 2.0 tokens: Postman's "Available Tokens". */
  readonly oauth2Tokens = this.oauth2Store.tokens;
  /** Whether the "Manage Tokens" dialog is open. */
  readonly managingOAuth2Tokens = this.oauth2Store.managing;
  loadOAuth2Tokens = () => this.oauth2Store.loadTokens();
  oauth2TokenDetails = (id: string) => this.oauth2Store.tokenDetails(id);
  deleteOAuth2Token = (id: string) => this.oauth2Store.deleteToken(id);
  /** Printable reports, and the one shown before printing it or saving it as PDF. */
  readonly reports = this.reportStore.reports;
  readonly report = this.reportStore.report;
  reportRequest = () => this.reportStore.request();
  reportCollection = (id: string) => this.reportStore.collection(id);
  closeReport = () => this.reportStore.close();
  // Cookies: Postman's "Manage Cookies".
  readonly cookies = this.cookieStore.cookies;
  readonly managingCookies = this.cookieStore.managing;
  manageCookies = () => this.cookieStore.manage();
  loadCookies = () => this.cookieStore.load();
  saveCookie: CookiesStore['save'] = (...args) => this.cookieStore.save(...args);
  deleteCookie: CookiesStore['delete'] = (...args) => this.cookieStore.delete(...args);
  clearCookies: CookiesStore['clear'] = (...args) => this.cookieStore.clear(...args);

  // OAuth 2.0 browser sign-in.
  /** The browser sign-in in progress, shown in a dialog until it finishes. */
  readonly oauth2SignIn = this.oauth2Store.signIn.current;
  completeOAuth2SignIn = (url: string) => this.oauth2Store.signIn.complete(url);
  useOAuth2Token = (pasted: PastedOAuth2Token) => this.oauth2Store.signIn.usePasted(pasted);
  reopenOAuth2SignIn = () => this.oauth2Store.signIn.reopen();
  cancelOAuth2SignIn = () => this.oauth2Store.signIn.cancel();

  async send() {
    await this.oauth2Store.signInBeforeSending();
    return this.requests.send();
  }
  cancel() {
    return this.guard(() => this.requests.cancel());
  }

  // GraphQL schemas, by endpoint URL, loaded again in each session as in Postman.
  readonly graphqlSchemas = this.schemaStore.schemas;
  readonly loadingSchema = this.schemaStore.loading;
  schemaFor = (url: string) => this.schemaStore.schemaFor(url);
  loadGraphqlSchema = () => this.schemaStore.loadActive();
  loadEndpointSchema: SchemasStore['loadEndpoint'] = (...args) =>
    this.schemaStore.loadEndpoint(...args);
  openHistory = (document: WorkspaceDocument) =>
    this.guard(() => this.requests.openHistory(document));
  recordRun = (run: Run, collectionId: string) => this.requests.recordRun(run, collectionId);

  // Documents and variables.
  importContent = (content: string) => this.saves.importContent(content);
  /** Downloads a collection or environment as JSON, and says so. */
  export = (document: WorkspaceDocument) => this.saves.export(document);
  remove = (document: WorkspaceDocument) => this.saves.remove(document);
  selectEnvironment = (id: string) => this.variableStore.select(id);
  /** Tells that the person kept variables changed elsewhere instead of saving theirs. */
  variablesReloaded = () => this.saves.variablesReloaded();
  saveEnvironment: SavesStore['saveEnvironment'] = (...args) => this.saves.saveEnvironment(...args);
  saveGlobals = (rows: readonly VariableRow[]) => this.saves.saveGlobals(rows);
}
