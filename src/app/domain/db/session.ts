/**
 * What the database section keeps in the workspace session: the navigator as it was, and
 * its editor tabs with the unsaved text of each script. Results are never kept.
 */
import { DbBookmark } from './tree';

export type DbTabKind = 'connection' | 'sql' | 'object';

/** An editor tab of the section. */
export interface DbTab {
  id: string;
  kind: DbTabKind;
  /** The saved connection it belongs to; empty for a connection not saved yet. */
  connection: string;
  /** Shown while it has nothing better to take its name from. */
  title: string;
  /** An object tab: the object's path in the tree. */
  path?: string[];
}

/** What a SQL tab holds besides its results. */
export interface SqlDraft {
  text: string;
  /** Where the cursor was, in UTF-16 units. */
  cursor: number;
  /** The saved script it edits, if any. */
  script?: string;
  /** Text not saved in its script yet. */
  dirty?: boolean;
  /** Another database of the server than the connection's. */
  database?: string;
}

export interface DatabaseSession {
  /** Keys of the open nodes; a connection opens again only when the person connects it. */
  expanded: string[];
  /** The connection last chosen. */
  active: string;
  bookmarks: DbBookmark[];
  /** The simple view hides system objects. */
  simple: boolean;
  tabs: DbTab[];
  activeTab: string;
  /** The SQL tabs' texts, by tab. */
  drafts: Record<string, SqlDraft>;
}

export function emptyDatabaseSession(): DatabaseSession {
  return {
    expanded: [],
    active: '',
    bookmarks: [],
    simple: true,
    tabs: [],
    activeTab: '',
    drafts: {},
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (item: unknown) =>
  Array.isArray(item) ? item.filter((x): x is string => typeof x === 'string') : [];
const text = (source: Record<string, unknown>, key: string) =>
  typeof source[key] === 'string' ? (source[key] as string) : '';

function readTab(item: unknown): DbTab[] {
  const tab = record(item);
  const kind = tab['kind'];
  if (
    typeof tab['id'] !== 'string' ||
    (kind !== 'connection' && kind !== 'sql' && kind !== 'object')
  )
    return [];
  return [
    {
      id: tab['id'],
      kind,
      connection: text(tab, 'connection'),
      title: text(tab, 'title'),
      ...(kind === 'object' ? { path: strings(tab['path']) } : {}),
    },
  ];
}

function readDraft(item: unknown): SqlDraft {
  const draft = record(item);
  return {
    text: text(draft, 'text'),
    cursor: typeof draft['cursor'] === 'number' && draft['cursor'] >= 0 ? draft['cursor'] : 0,
    ...(text(draft, 'script') ? { script: text(draft, 'script') } : {}),
    ...(draft['dirty'] === true ? { dirty: true } : {}),
    ...(text(draft, 'database') ? { database: text(draft, 'database') } : {}),
  };
}

/** Reads what a stored session holds for the database section, leaving out the rest. */
export function readDatabaseSession(value: unknown): DatabaseSession {
  const stored = record(value);
  const bookmarks = (Array.isArray(stored['bookmarks']) ? stored['bookmarks'] : []).flatMap(
    (item: unknown): DbBookmark[] => {
      const mark = record(item);
      if (typeof mark['connection'] !== 'string' || typeof mark['label'] !== 'string') return [];
      return [
        {
          connection: mark['connection'],
          path: strings(mark['path']),
          label: mark['label'],
          kind: text(mark, 'kind'),
        },
      ];
    },
  );
  const tabs = (Array.isArray(stored['tabs']) ? stored['tabs'] : []).flatMap(readTab);
  const drafts = Object.fromEntries(
    Object.entries(record(stored['drafts']))
      .filter(([id]) => tabs.some((tab) => tab.id === id && tab.kind === 'sql'))
      .map(([id, draft]) => [id, readDraft(draft)]),
  );
  return {
    expanded: strings(stored['expanded']),
    active: text(stored, 'active'),
    bookmarks,
    simple: stored['simple'] !== false,
    tabs,
    activeTab: tabs.some((tab) => tab.id === stored['activeTab']) ? text(stored, 'activeTab') : '',
    drafts,
  };
}

/**
 * The drafts worth keeping: a script saved and unchanged reopens from its document, so only
 * its cursor is kept; anything else keeps its text.
 */
export function storedDrafts(drafts: Readonly<Record<string, SqlDraft>>) {
  return Object.fromEntries(
    Object.entries(drafts).map(([id, draft]) => [
      id,
      draft.script && !draft.dirty ? { ...draft, text: '' } : draft,
    ]),
  );
}
