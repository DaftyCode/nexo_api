import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { WORKSPACE } from '../composition/providers';
import { ExecutionOperation } from '../application/operations';
import { CollectionItem, RequestDraft, Run, WorkspaceDocument } from '../domain/models';
import {
  ResolvedVariable,
  VariableRow,
  VariableScopes,
  inheritedCollectionVariables,
  requestVariables,
  resolveVariable,
} from '../domain/variables';
import { TabsStore } from './tabs-store';
import { CollectionsStore } from './state/collections-store';
import { DocumentsStore } from './state/documents-store';
import { RequestsStore } from './state/requests-store';
import { SessionStore } from './state/session-store';
import { StateContext, StatusStore } from './state/state-context';
import { VariablesStore } from './state/variables-store';

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
  readonly consoleOpen = signal(false);
  /** Collection whose variables, auth and scripts are edited in the collection settings view. */
  readonly settingsCollectionId = signal('');

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
  describe(error: unknown) {
    return this.status.describe(error);
  }
  /** Runs an engine operation inside the current workspace. */
  execute<T>(operation: ExecutionOperation, payload: Record<string, unknown> = {}): Promise<T> {
    return this.cases.execute<T>(this.workspaceId(), operation, payload);
  }

  // Session and workspaces.
  initialize() {
    return this.guard(() => this.session.initialize());
  }
  signOut() {
    return this.guard(() => this.session.signOut());
  }
  createWorkspace(name: string) {
    return this.guard(async () => {
      await this.session.create(name);
      this.notice.set('Workspace created');
    });
  }
  renameWorkspace(name: string) {
    return this.guard(async () => {
      await this.session.rename(name);
      this.notice.set('Workspace renamed');
    });
  }
  deleteWorkspace() {
    return this.guard(async () => {
      if (await this.session.remove()) this.notice.set('Workspace deleted');
    });
  }
  selectWorkspace(id: string) {
    return this.session.select(id);
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
    return this.guard(async () => {
      await this.store.createCollection(name);
      this.notice.set('Collection created');
    });
  }
  addRequest(document: WorkspaceDocument, folderPath: number[] = []) {
    return this.guard(() => this.collectionStore.addRequest(document, folderPath));
  }
  addFolder(document: WorkspaceDocument, name: string, parent: number[] = []) {
    return this.guard(() =>
      this.collectionStore.change(document, (tree, collection) =>
        tree.addFolder(collection, parent, name, this.cases.files.id()),
      ),
    );
  }
  renameItem(document: WorkspaceDocument, path: number[], name: string) {
    return this.guard(() =>
      this.collectionStore.change(document, (tree, collection) =>
        tree.renameItem(collection, path, name),
      ),
    );
  }
  async removeItem(document: WorkspaceDocument, path: number[]) {
    if (!this.confirm('Delete this item and everything inside it?')) return;
    await this.guard(() =>
      this.collectionStore.change(document, (tree, collection) =>
        tree.removeItem(collection, path),
      ),
    );
  }
  reorderItem(document: WorkspaceDocument, path: number[], offset: -1 | 1) {
    return this.guard(() =>
      this.collectionStore.change(document, (tree, collection) =>
        tree.reorderItem(collection, path, offset),
      ),
    );
  }
  moveItem(document: WorkspaceDocument, path: number[], folder: number[]) {
    return this.guard(() =>
      this.collectionStore.change(document, (tree, collection) =>
        tree.moveInto(collection, path, folder),
      ),
    );
  }
  saveActive(targetDocumentId?: string) {
    return this.guard(() => this.collectionStore.saveActive(targetDocumentId));
  }
  openCollectionSettings(id: string) {
    this.settingsCollectionId.set(id);
    this.section.set('collection-settings');
  }
  saveCollectionSettings(
    id: string,
    settings: { variables: readonly VariableRow[]; auth?: unknown; event?: unknown },
  ) {
    return this.guard(async () => {
      await this.store.saveCollectionSettings(id, settings);
      this.notice.set('Collection saved');
    });
  }

  // Requests and history.
  send() {
    return this.requests.send();
  }
  cancel() {
    return this.guard(() => this.requests.cancel());
  }
  openHistory(document: WorkspaceDocument) {
    return this.guard(() => this.requests.openHistory(document));
  }
  recordRun(run: Run, collectionId: string) {
    return this.requests.recordRun(run, collectionId);
  }

  // Documents and variables.
  importContent(content: string) {
    return this.guard(async () => {
      await this.store.importContent(content);
      this.variableStore.validate();
      this.notice.set('Import completed');
    });
  }
  export(document: WorkspaceDocument) {
    this.cases.export(document);
  }
  remove(document: WorkspaceDocument) {
    return this.guard(async () => {
      await this.store.remove(document);
      if (this.environmentId() === document.id) this.selectEnvironment('');
      this.notice.set('Deleted');
    });
  }
  selectEnvironment(id: string) {
    this.variableStore.select(id);
  }
  async saveEnvironment(id: string, name: string, rows: readonly VariableRow[]) {
    let saved: WorkspaceDocument | undefined;
    await this.guard(async () => {
      saved = await this.variableStore.saveEnvironment(id, name, rows);
      this.notice.set('Environment saved');
    });
    return saved;
  }
  saveGlobals(rows: readonly VariableRow[]) {
    return this.guard(async () => {
      await this.variableStore.saveGlobals(rows);
      this.notice.set('Global variables saved');
    });
  }
}
