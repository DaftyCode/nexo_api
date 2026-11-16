/**
 * The rows the navigator draws, in order: folders of connections, connections and the nodes
 * loaded under them, with the filters applied. A text filter shows what matches among the
 * loaded nodes, with the nodes that lead to it.
 */
import { ConnectionType, connectionType, filterAt, readDbConnection } from './connection';
import { engineProfile } from './engines';
import { readScript } from './sql';
import { ConnectionStatus, DbNode, filtered, matchesText, nodeKey, simpleView } from './tree';

export interface NavigatorRow {
  key: string;
  type:
    | 'folder'
    | 'connection'
    | 'node'
    | 'loading'
    | 'error'
    | 'empty'
    | 'scripts'
    | 'script-group'
    | 'script';
  /** 1 for the top level, as `aria-level`. */
  level: number;
  label: string;
  detail?: string;
  /** The connection of the row, and the path of a node. */
  connection?: string;
  path?: string[];
  node?: DbNode;
  folder?: string;
  expandable: boolean;
  expanded: boolean;
  /** The key of the row it is under, for the keyboard. */
  parent?: string;
  status?: ConnectionStatus;
  kind?: ConnectionType;
  readOnly?: boolean;
  driver?: string;
  /** The `sql-script` document of a script row. */
  script?: string;
}

export interface NavigatorSnapshot {
  connections: readonly { id: string; name: string; value: unknown }[];
  folders: readonly { folder: string; connections: readonly { id: string }[] }[];
  expanded: ReadonlySet<string>;
  closedFolders: ReadonlySet<string>;
  children: ReadonlyMap<string, readonly DbNode[]>;
  loading: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  status: Readonly<Record<string, ConnectionStatus>>;
  simple: boolean;
  text: string;
  /** Saved SQL scripts (`sql-script` documents). */
  scripts?: readonly { id: string; name: string; value: unknown }[];
}

export const folderKey = (folder: string) => `folder:${encodeURIComponent(folder)}`;

/** Whether a node or one of its loaded descendants holds the text. */
function holdsText(
  snapshot: NavigatorSnapshot,
  connection: string,
  path: readonly string[],
  node: DbNode,
): boolean {
  if (matchesText(node, snapshot.text)) return true;
  const children = snapshot.children.get(nodeKey(connection, path)) ?? [];
  return children.some((child) => holdsText(snapshot, connection, [...path, child.name], child));
}

function shownChildren(
  snapshot: NavigatorSnapshot,
  connection: string,
  value: ReturnType<typeof readDbConnection>,
  path: readonly string[],
): DbNode[] {
  const loaded = snapshot.children.get(nodeKey(connection, path)) ?? [];
  const nodes = simpleView(filtered(loaded, filterAt(value, path)), snapshot.simple);
  return snapshot.text.trim()
    ? nodes.filter((node) => holdsText(snapshot, connection, [...path, node.name], node))
    : nodes;
}

function nodeRows(
  snapshot: NavigatorSnapshot,
  connection: string,
  value: ReturnType<typeof readDbConnection>,
  path: readonly string[],
  level: number,
  rows: NavigatorRow[],
) {
  const parent = nodeKey(connection, path);
  if (snapshot.loading.has(parent)) {
    rows.push({
      key: `${parent}#loading`,
      type: 'loading',
      level,
      label: 'Loading',
      parent,
      expandable: false,
      expanded: false,
    });
    return;
  }
  const error = snapshot.errors.get(parent);
  if (error) {
    rows.push({
      key: `${parent}#error`,
      type: 'error',
      level,
      label: error,
      parent,
      expandable: false,
      expanded: false,
    });
    return;
  }
  const nodes = shownChildren(snapshot, connection, value, path);
  if (!nodes.length && snapshot.children.has(parent) && !snapshot.text.trim())
    rows.push({
      key: `${parent}#empty`,
      type: 'empty',
      level,
      label: 'No objects',
      parent,
      expandable: false,
      expanded: false,
    });
  for (const node of nodes) {
    const nodePath = [...path, node.name];
    const key = nodeKey(connection, nodePath);
    const searching = !!snapshot.text.trim() && snapshot.children.has(key);
    const expanded = node.hasChildren && (snapshot.expanded.has(key) || searching);
    rows.push({
      key,
      type: 'node',
      level,
      label: node.label,
      ...(node.detail ? { detail: node.detail } : {}),
      connection,
      path: nodePath,
      node,
      parent,
      expandable: node.hasChildren,
      expanded,
    });
    if (expanded) nodeRows(snapshot, connection, value, nodePath, level + 1, rows);
  }
}

/** The rows of the navigator. */
export function navigatorRows(snapshot: NavigatorSnapshot): NavigatorRow[] {
  const rows: NavigatorRow[] = [];
  const byId = new Map(snapshot.connections.map((connection) => [connection.id, connection]));
  for (const group of snapshot.folders) {
    const folder = group.folder ? folderKey(group.folder) : undefined;
    const open = !folder || !snapshot.closedFolders.has(folder) || !!snapshot.text.trim();
    const level = folder ? 2 : 1;
    const inside: NavigatorRow[] = [];
    for (const { id } of group.connections) {
      const document = byId.get(id);
      if (!document) continue;
      const value = readDbConnection(document.value);
      const status = snapshot.status[id] ?? 'disconnected';
      const key = nodeKey(id, []);
      const expanded = snapshot.expanded.has(key) && status === 'connected';
      const matches =
        !snapshot.text.trim() ||
        matchesText({ label: document.name }, snapshot.text) ||
        shownChildren(snapshot, id, value, []).length > 0;
      if (!matches) continue;
      inside.push({
        key,
        type: 'connection',
        level,
        label: document.name,
        detail: [
          value.driver ? engineProfile(value.driver).name : '',
          [value.host, value.port].filter(Boolean).join(':'),
        ]
          .filter(Boolean)
          .join(' · '),
        connection: id,
        path: [],
        ...(folder ? { parent: folder, folder: group.folder } : {}),
        expandable: true,
        expanded: expanded || (!!snapshot.text.trim() && status === 'connected'),
        status,
        kind: connectionType(value),
        readOnly: !!value.readOnly,
        driver: value.driver,
      });
      if (inside.at(-1)?.expanded) {
        const nested: NavigatorRow[] = [];
        nodeRows(snapshot, id, value, [], level + 1, nested);
        inside.push(...nested);
      }
    }
    if (folder && (inside.length || !snapshot.text.trim()))
      rows.push({
        key: folder,
        type: 'folder',
        level: 1,
        label: group.folder,
        folder: group.folder,
        expandable: true,
        expanded: open,
      });
    if (open) rows.push(...inside);
  }
  rows.push(...scriptRows(snapshot));
  return rows;
}

export const SCRIPTS_KEY = 'scripts';

/** The saved scripts, under «Scripts», by connection. */
function scriptRows(snapshot: NavigatorSnapshot): NavigatorRow[] {
  const text = snapshot.text.trim();
  const scripts = (snapshot.scripts ?? []).filter(
    (script) => !text || matchesText({ label: script.name }, text),
  );
  if (!scripts.length) return [];
  const open = !snapshot.closedFolders.has(SCRIPTS_KEY) || !!text;
  const rows: NavigatorRow[] = [
    {
      key: SCRIPTS_KEY,
      type: 'scripts',
      level: 1,
      label: 'Scripts',
      expandable: true,
      expanded: open,
    },
  ];
  if (!open) return rows;
  const owner = (script: { value: unknown }) => readScript(script.value).connectionId;
  const ids = [...new Set(scripts.map(owner))].sort((a, b) =>
    nameOf(snapshot, a).localeCompare(nameOf(snapshot, b)),
  );
  for (const id of ids) {
    const key = `${SCRIPTS_KEY}:${id}`;
    const expanded = !snapshot.closedFolders.has(key) || !!text;
    rows.push({
      key,
      type: 'script-group',
      level: 2,
      label: nameOf(snapshot, id),
      connection: id,
      parent: SCRIPTS_KEY,
      expandable: true,
      expanded,
    });
    if (!expanded) continue;
    for (const script of scripts
      .filter((item) => owner(item) === id)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const folder = readScript(script.value).folder;
      rows.push({
        key: `script:${script.id}`,
        type: 'script',
        level: 3,
        label: script.name,
        ...(folder ? { detail: folder } : {}),
        connection: id,
        script: script.id,
        parent: key,
        expandable: false,
        expanded: false,
      });
    }
  }
  return rows;
}

function nameOf(snapshot: NavigatorSnapshot, id: string) {
  return snapshot.connections.find((connection) => connection.id === id)?.name ?? '—';
}
