/**
 * What the database section keeps in the workspace session: the navigator as it was, and
 * its editor tabs with the unsaved text of each script. Results are never kept.
 */
import { DiagramLayout, readLayouts } from './erd-document';
import { QuickFilter, TableQuery } from './table-query';
import { DbBookmark } from './tree';

export type DbTabKind =
  'connection' | 'sql' | 'object' | 'console' | 'diagram' | 'sessions' | 'locks';

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
  /** An object tab: the filter and order of its «Data» tab. */
  query?: TableQuery;
  /** An object tab: the view it shows (properties, data, a section, DDL), as it was left. */
  part?: string;
  /** A diagram tab: the saved diagram it shows; without one, the tables under `path`. */
  diagram?: string;
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
  /** Where the entities of the automatic diagrams were moved, by diagram (DB-20). */
  diagrams?: Record<string, DiagramLayout>;
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
    !['connection', 'sql', 'object', 'console', 'diagram', 'sessions', 'locks'].includes(
      String(kind),
    )
  )
    return [];
  return [
    {
      id: tab['id'],
      kind: kind as DbTabKind,
      connection: text(tab, 'connection'),
      title: text(tab, 'title'),
      ...(kind === 'object' || kind === 'diagram' ? { path: strings(tab['path']) } : {}),
      ...(kind === 'diagram' && text(tab, 'diagram') ? { diagram: text(tab, 'diagram') } : {}),
      ...(kind === 'object' && tab['query'] ? { query: readQuery(tab['query']) } : {}),
      ...(kind === 'object' && text(tab, 'part') ? { part: text(tab, 'part') } : {}),
    },
  ];
}

const OPERATORS = ['eq', 'ne', 'null', 'notnull', 'contains'];

/** The filter and order of a «Data» tab, as stored. */
function readQuery(value: unknown): TableQuery {
  const query = record(value);
  const quick = (Array.isArray(query['quick']) ? query['quick'] : []).flatMap(
    (item: unknown): QuickFilter[] => {
      const filter = record(item);
      if (typeof filter['column'] !== 'string' || !OPERATORS.includes(String(filter['operator'])))
        return [];
      return [
        {
          column: filter['column'],
          operator: filter['operator'] as QuickFilter['operator'],
          ...('value' in filter ? { value: filter['value'] } : {}),
        },
      ];
    },
  );
  const order = (Array.isArray(query['order']) ? query['order'] : []).flatMap((item: unknown) => {
    const level = record(item);
    return typeof level['column'] === 'string'
      ? [{ column: level['column'], descending: level['descending'] === true }]
      : [];
  });
  return { where: text(query, 'where'), quick, order };
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
    ...(stored['diagrams'] ? { diagrams: readLayouts(stored['diagrams']) } : {}),
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

/**
 * The drafts of a stored session, as they open again: a saved script that had not changed
 * reads its text from its document (`script` gives it); one whose script was deleted keeps
 * its text, as unsaved.
 */
export function restoredDrafts(
  drafts: Readonly<Record<string, SqlDraft>>,
  script: (id: string) => string | undefined,
): Record<string, SqlDraft> {
  return Object.fromEntries(
    Object.entries(drafts).map(([id, draft]) => {
      if (!draft.script) return [id, draft];
      const text = script(draft.script);
      if (text === undefined) return [id, { ...draft, script: undefined, dirty: true }];
      return [id, draft.text ? draft : { ...draft, text }];
    }),
  );
}
