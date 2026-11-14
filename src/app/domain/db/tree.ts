/**
 * The navigator of the database section: the nodes a driver gives, the filters DBeaver
 * offers over them, and names copied as the engine quotes them.
 */
import { NodeFilter } from './connection';

/** A node of a connection's tree, as the driver describes it. */
export interface DbNode {
  /** `database`, `schema`, `table`, `view`, `column`, `index`, `folder`… */
  kind: string;
  /** The segment it adds to its parent's path. */
  name: string;
  label: string;
  detail?: string;
  hasChildren: boolean;
  actions: string[];
  /** The engine's own objects and administration folders: the simple view hides them. */
  system?: boolean;
}

/** Where a connection stands in the navigator. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** The key of a node in the navigator: its connection and path, so it survives a reload. */
export function nodeKey(connection: string, path: readonly string[]): string {
  return [connection, ...path].map(encodeURIComponent).join('/');
}
/** The connection and path of a key. */
export function keyPath(key: string): { connection: string; path: string[] } {
  const [connection, ...path] = key.split('/').map(decodeURIComponent);
  return { connection: connection ?? '', path };
}

/** Whether a name matches a comma-separated list of patterns with `*`, `%` and `?`. */
export function matchesPatterns(name: string, patterns: string): boolean {
  return patterns
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .some((pattern) => {
      const source = pattern
        .split('')
        .map((char) =>
          char === '*' || char === '%'
            ? '.*'
            : char === '?'
              ? '.'
              : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
        )
        .join('');
      return new RegExp(`^${source}$`, 'i').test(name);
    });
}

/** The children a filter lets through: folders are never filtered, only objects. */
export function filtered(nodes: readonly DbNode[], filter: NodeFilter | undefined): DbNode[] {
  if (!filter) return [...nodes];
  return nodes.filter((node) => {
    if (node.kind === 'folder') return true;
    const name = node.label;
    if (filter.include && !matchesPatterns(name, filter.include)) return false;
    return !(filter.exclude && matchesPatterns(name, filter.exclude));
  });
}

/** The children shown in the simple view, which hides system objects. */
export function simpleView(nodes: readonly DbNode[], simple: boolean): DbNode[] {
  return simple ? nodes.filter((node) => !node.system) : [...nodes];
}

/** Whether a node's label holds the text typed in the navigator's filter. */
export function matchesText(node: Pick<DbNode, 'label'>, text: string): boolean {
  const wanted = text.trim().toLowerCase();
  return !wanted || node.label.toLowerCase().includes(wanted);
}

/** How an engine quotes its names, from what its driver says. */
export interface QuoteStyle {
  quoteOpen: string;
  quoteClose: string;
  keywords?: readonly string[];
}

/** A name as SQL needs it: quoted when it is not a plain lowercase name or is a keyword. */
export function quoteName(name: string, style: QuoteStyle): string {
  const keyword = style.keywords?.some((word) => word.toLowerCase() === name.toLowerCase());
  if (/^[a-z_][a-z0-9_]*$/.test(name) && !keyword) return name;
  const escaped = name.split(style.quoteClose).join(style.quoteClose + style.quoteClose);
  return `${style.quoteOpen}${escaped}${style.quoteClose}`;
}

/** Routines are named by their signature: `name(arguments)`, with the name quoted. */
const ROUTINES = new Set(['function', 'procedure', 'aggregate']);

/** The name copied from a node: quoted, and with its arguments for a routine. */
export function copiedName(node: Pick<DbNode, 'kind' | 'label'>, style: QuoteStyle): string {
  if (ROUTINES.has(node.kind)) {
    const open = node.label.indexOf('(');
    if (open > 0) return quoteName(node.label.slice(0, open), style) + node.label.slice(open);
  }
  return quoteName(node.label, style);
}

/** A node the person marked, shown above the tree. */
export interface DbBookmark {
  connection: string;
  path: string[];
  label: string;
  kind: string;
}

/** Marks a node, or unmarks it when it was marked. */
export function toggleBookmark(list: readonly DbBookmark[], bookmark: DbBookmark): DbBookmark[] {
  const key = nodeKey(bookmark.connection, bookmark.path);
  return list.some((item) => nodeKey(item.connection, item.path) === key)
    ? list.filter((item) => nodeKey(item.connection, item.path) !== key)
    : [...list, bookmark];
}

/** What the database section keeps in the workspace session. */
export interface DatabaseSession {
  /** Keys of the open nodes; a connection opens again only when the person connects it. */
  expanded: string[];
  /** The connection last chosen. */
  active: string;
  bookmarks: DbBookmark[];
  /** The simple view hides system objects. */
  simple: boolean;
}

export function emptyDatabaseSession(): DatabaseSession {
  return { expanded: [], active: '', bookmarks: [], simple: true };
}

/** Reads what a stored session holds for the database section, leaving out the rest. */
export function readDatabaseSession(value: unknown): DatabaseSession {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const strings = (item: unknown) =>
    Array.isArray(item) ? item.filter((x): x is string => typeof x === 'string') : [];
  const bookmarks = (Array.isArray(stored['bookmarks']) ? stored['bookmarks'] : []).flatMap(
    (item: unknown): DbBookmark[] => {
      const mark = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      if (typeof mark['connection'] !== 'string' || typeof mark['label'] !== 'string') return [];
      return [
        {
          connection: mark['connection'],
          path: strings(mark['path']),
          label: mark['label'],
          kind: typeof mark['kind'] === 'string' ? mark['kind'] : '',
        },
      ];
    },
  );
  return {
    expanded: strings(stored['expanded']),
    active: typeof stored['active'] === 'string' ? stored['active'] : '',
    bookmarks,
    simple: stored['simple'] !== false,
  };
}
