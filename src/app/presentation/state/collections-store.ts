import { computed, signal } from '@angular/core';
import * as tree from '../../domain/collection-tree';
import { failureCode } from '../../application/ports';
import {
  Collection,
  CollectionItem,
  WorkspaceDocument,
  asCollection,
  fromItem,
  items,
  newRequest,
  toItem,
} from '../../domain/models';
import { RequestAncestor, requestAncestors } from '../../domain/variables';
import { Inheritance, inheritedAuth } from '../../domain/auth';
import { DocumentsStore } from './documents-store';
import { StateContext } from './state-context';

/** Collection trees, the requests opened from them and saving requests back. */
export class CollectionsStore {
  readonly filter = signal('');
  /** Visible tree rows of every collection, recalculated when collections or the filter change. */
  readonly trees = computed(
    () =>
      new Map(this.documents.collections().map((document) => [document.id, this.rows(document)])),
  );
  /** Saved collection that contains the active request, if any. */
  readonly activeCollection = computed(() => {
    const id = this.context.tabs.active()?.documentId;
    return id ? this.documents.collections().find((d) => d.id === id) : undefined;
  });
  readonly activeAncestors = computed<RequestAncestor[]>(() => {
    const tab = this.context.tabs.active();
    const document = this.activeCollection();
    if (!tab || !document) return [];
    try {
      return requestAncestors(asCollection(document.value), tab.path);
    } catch {
      return [];
    }
  });

  /**
   * Where the active request takes its authorization from when it inherits it. `undefined`
   * when the request is not saved in a collection; `source` is missing when no folder or
   * collection above it sets one.
   */
  readonly activeInheritance = computed<Inheritance | undefined>(() => {
    const tab = this.context.tabs.active();
    const document = this.activeCollection();
    if (!tab || !document) return undefined;
    try {
      return { source: inheritedAuth(asCollection(document.value), tab.path) };
    } catch {
      return undefined;
    }
  });

  constructor(
    private readonly context: StateContext,
    private readonly documents: DocumentsStore,
  ) {}

  rows(document: WorkspaceDocument) {
    const filter = this.filter().toLowerCase();
    try {
      return items(asCollection(document.value)).filter(
        (x) => !filter || x.item.name.toLowerCase().includes(filter),
      );
    } catch {
      return [];
    }
  }
  /** Opens a request of a collection, or the tab that already shows it. */
  open(document: WorkspaceDocument, item: CollectionItem, path: number[]) {
    if (item.item) return;
    const { tabs, section } = this.context;
    const open = tabs.find(document.id, path);
    if (open) {
      tabs.activeId.set(open.id);
      section.set('collections');
      return;
    }
    const draft = fromItem(item, this.context.cases.files.id());
    tabs.open(draft, document.id, path);
    // Protocol requests open in the protocols panel with their saved settings.
    section.set(draft.realtime ? 'realtime' : 'collections');
  }
  async addRequest(document: WorkspaceDocument, folderPath: number[] = []) {
    const value = structuredClone(asCollection(document.value));
    let target = value.item;
    for (const index of folderPath) target = target[index].item ??= [];
    const draft = newRequest(this.context.cases.files.id());
    draft.name = 'New request';
    const index = target.push(toItem(draft)) - 1;
    const saved = await this.context.cases.saveDocument({ ...document, value });
    this.documents.applySaved([saved]);
    this.context.tabs.open(draft, saved.id, [...folderPath, index]);
    this.context.section.set('collections');
  }
  /**
   * Saves a change to a collection tree. Open requests follow their item to its new path and
   * take its new name, as in Postman, so saving them does not undo a rename. Requests whose
   * item was removed stay open, detached from the collection.
   */
  async change(
    document: WorkspaceDocument,
    change: (operations: typeof tree, collection: Collection) => Collection,
  ) {
    const before = tree.withIds(asCollection(document.value), () => this.context.cases.files.id());
    const followed = this.context.tabs
      .tabs()
      .filter((tab) => tab.documentId === document.id)
      .map((tab) => ({ tab: tab.id, item: tree.itemAt(before, tab.path)?.id }));
    const value = change(tree, before);
    this.documents.applySaved([await this.context.cases.saveDocument({ ...document, value })]);
    this.context.tabs.tabs.update((tabs) =>
      tabs.map((tab) => {
        const entry = followed.find((f) => f.tab === tab.id);
        if (!entry) return tab;
        const path = entry.item ? tree.pathOf(value, entry.item) : undefined;
        if (!path) return { ...tab, documentId: '', path: [], dirty: true };
        const name = tree.itemAt(value, path)?.name;
        return name && name !== tab.request.name
          ? { ...tab, path, request: { ...tab.request, name } }
          : { ...tab, path };
      }),
    );
  }
  /** Saves the active request into its collection, or into a new one. */
  async saveActive(targetDocumentId?: string) {
    const { tabs, cases, status } = this.context;
    const tab = tabs.active();
    if (!tab) return;
    let document = this.documents
      .collections()
      .find((d) => d.id === (targetDocumentId ?? tab.documentId));
    document ??= await this.documents.createCollection('My collection');
    const path =
      tab.documentId === document.id && tab.path.length
        ? tab.path
        : [asCollection(document.value).item.length];
    let saved: WorkspaceDocument;
    try {
      saved = await cases.saveRequest(document, path, tab.request);
    } catch (error) {
      if (failureCode(error) !== 'conflict') throw error;
      // The collection changed after it was loaded: reload it and let the user choose.
      await this.documents.refresh();
      const latest = this.documents.collections().find((d) => d.id === document.id);
      if (!latest) throw error;
      const message =
        'This collection changed since you opened it. Save your request over the latest version?';
      if (!this.context.confirm(message)) {
        status.notice.set('Collection reloaded');
        return;
      }
      saved = await cases.saveRequest(latest, path, tab.request);
    }
    this.documents.applySaved([saved]);
    tabs.tabs.update((t) =>
      t.map((x) => (x.id === tab.id ? { ...x, documentId: saved.id, path, dirty: false } : x)),
    );
    status.notice.set('Request saved');
  }
}
