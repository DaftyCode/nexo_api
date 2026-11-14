import { itemAt, pathOf } from './collection-tree';
import { DatabaseSession, readDatabaseSession } from './db/tree';
import {
  RequestDraft,
  RequestTab,
  WorkspaceDocument,
  asCollection,
  fromItem,
  newRequest,
} from './models';

/**
 * What a workspace shows when it opens again, as the engine stores it (`session` document):
 * the open tabs, the active one and the order the person gave to its collections. Responses
 * are never part of it.
 */
export interface WorkspaceSession {
  tabs: SessionTab[];
  activeTab: string;
  /** Collection ids in the order of the sidebar; collections not listed go before them. */
  collections: string[];
  /** The section of the side menu that was open, such as `collections` or `mongo`. */
  section?: string;
  /** The navigator of the database section: open nodes, the active connection, bookmarks. */
  databases?: DatabaseSession;
}
/** An open tab: the collection item it shows and, when it has unsaved changes, those. */
export interface SessionTab {
  id: string;
  /** The collection of the request; empty for a request not saved in one. */
  documentId: string;
  path: number[];
  /** The item followed across moves, when it has an id. */
  itemId?: string;
  /** The name of the item when the session was saved, to notice another item at its path. */
  itemName?: string;
  /**
   * The request exactly as it was being edited, without the content of the files chosen for
   * it (never stored, as in collections). Present for unsaved changes and for requests not
   * saved in a collection.
   */
  draft?: RequestDraft;
  /** Whether the tab had unsaved changes. */
  dirty?: boolean;
}
/** The id of the session of a workspace: one per workspace, saved over each time. */
export const sessionId = (workspace: string) => `session-${workspace}`;

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
const indexes = (value: unknown) =>
  Array.isArray(value) ? value.filter((x): x is number => Number.isInteger(x) && x >= 0) : [];

/** Reads a stored session, leaving out what is not well formed. */
export function readSession(value: unknown): WorkspaceSession {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const tabs = (Array.isArray(stored['tabs']) ? stored['tabs'] : []).flatMap(
    (tab: Record<string, unknown> | null): SessionTab[] => {
      if (!tab || typeof tab !== 'object' || typeof tab['id'] !== 'string') return [];
      const draft = tab['draft'];
      return [
        {
          id: tab['id'],
          documentId: typeof tab['documentId'] === 'string' ? tab['documentId'] : '',
          path: indexes(tab['path']),
          ...(typeof tab['itemId'] === 'string' ? { itemId: tab['itemId'] } : {}),
          ...(typeof tab['itemName'] === 'string' ? { itemName: tab['itemName'] } : {}),
          ...(draft && typeof draft === 'object' && typeof (draft as RequestDraft).name === 'string'
            ? { draft: draft as RequestDraft }
            : {}),
          ...(tab['dirty'] === true ? { dirty: true } : {}),
        },
      ];
    },
  );
  return {
    tabs,
    activeTab: typeof stored['activeTab'] === 'string' ? stored['activeTab'] : '',
    collections: strings(stored['collections']),
    ...(typeof stored['section'] === 'string' ? { section: stored['section'] } : {}),
    ...(stored['databases'] && typeof stored['databases'] === 'object'
      ? { databases: readDatabaseSession(stored['databases']) }
      : {}),
  };
}

/** A request without the content of its chosen files, which stays in the open tab only. */
function storable(request: RequestDraft): RequestDraft {
  const copy = structuredClone(request);
  copy.form = copy.form.map(({ files: _files, ...row }) => row);
  if (copy.bodyFile) copy.bodyFile = { src: copy.bodyFile.src };
  return copy;
}
/** A stored draft as a request: fields added since it was stored take their default. */
function draftRequest(draft: RequestDraft, id: string): RequestDraft {
  return { ...newRequest(id), ...draft, id };
}

function savedItem(documents: readonly WorkspaceDocument[], documentId: string, path: number[]) {
  const document = documents.find((d) => d.id === documentId && d.kind === 'collection');
  if (!document || !path.length) return undefined;
  try {
    return itemAt(asCollection(document.value), path);
  } catch {
    return undefined;
  }
}

/** The session of the open tabs; `keepTabs` false keeps only the order of the collections. */
export function sessionOf(
  tabs: readonly RequestTab[],
  activeTab: string,
  collections: readonly string[],
  documents: readonly WorkspaceDocument[],
  keepTabs = true,
): WorkspaceSession {
  if (!keepTabs) return { tabs: [], activeTab: '', collections: [...collections] };
  return {
    tabs: tabs.map((tab) => {
      const item = tab.documentId ? savedItem(documents, tab.documentId, tab.path) : undefined;
      const saved = !!item && !item.item;
      return {
        id: tab.id,
        documentId: saved ? tab.documentId : '',
        path: saved ? [...tab.path] : [],
        ...(saved && item.id ? { itemId: item.id } : {}),
        ...(saved ? { itemName: item.name } : {}),
        ...(tab.dirty || !saved ? { draft: storable(tab.request) } : {}),
        ...(tab.dirty ? { dirty: true } : {}),
      };
    }),
    activeTab,
    collections: [...collections],
  };
}

/**
 * The tabs of a session, as they were: saved requests read again from their collection,
 * unsaved changes from the session. A saved tab whose request was deleted is dropped, and
 * counted; one with unsaved changes stays, detached from its collection, so they are not lost.
 */
export function restoreTabs(
  session: WorkspaceSession,
  documents: readonly WorkspaceDocument[],
  id: () => string,
): { tabs: RequestTab[]; activeTab: string; dropped: number } {
  let dropped = 0;
  const tabs = session.tabs.flatMap((tab): RequestTab[] => {
    const place = tab.documentId ? findItem(documents, tab) : undefined;
    if (place) {
      const draft = tab.dirty ? tab.draft : undefined;
      const request = draft ? draftRequest(draft, id()) : fromItem(place.item, id());
      return [
        { id: tab.id, request, documentId: tab.documentId, path: place.path, dirty: !!draft },
      ];
    }
    if (!tab.draft || (tab.documentId && !tab.dirty)) {
      dropped += 1;
      return [];
    }
    const request = draftRequest(tab.draft, id());
    // Detached from a deleted request: its changes are kept, and closing it asks first.
    return [{ id: tab.id, request, documentId: '', path: [], dirty: !!tab.dirty }];
  });
  const activeTab = tabs.some((t) => t.id === session.activeTab)
    ? session.activeTab
    : (tabs.at(-1)?.id ?? '');
  return { tabs, activeTab, dropped };
}

/** Where the request of a tab is now: followed by its id, or at its path with the same name. */
function findItem(documents: readonly WorkspaceDocument[], tab: SessionTab) {
  const document = documents.find((d) => d.id === tab.documentId && d.kind === 'collection');
  if (!document) return undefined;
  try {
    const collection = asCollection(document.value);
    const path = (tab.itemId && pathOf(collection, tab.itemId)) || tab.path;
    const item = path.length ? itemAt(collection, path) : undefined;
    if (!item || item.item) return undefined;
    if (!tab.itemId || item.id !== tab.itemId) {
      if (tab.itemName !== undefined && item.name !== tab.itemName) return undefined;
    }
    return { item, path };
  } catch {
    return undefined;
  }
}
