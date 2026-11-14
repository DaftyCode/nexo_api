/** The icons of the navigator's rows and the entries of their actions menu. */

/** The icon of a node, by the class of object the driver says it is. */
export const ICONS: Record<string, string> = {
  database: 'databases',
  schema: 'schema',
  table: 'table',
  view: 'view',
  column: 'column',
  constraint: 'key',
  index: 'index',
  function: 'function',
  procedure: 'function',
  aggregate: 'function',
  sequence: 'sequence',
  trigger: 'trigger',
  role: 'role',
  folder: 'folder',
};

/** The entries of a row's actions menu. */
export type MenuAction =
  | 'connect'
  | 'disconnect'
  | 'reconnect'
  | 'edit'
  | 'rename'
  | 'duplicate'
  | 'moveTo'
  | 'remove'
  | 'copyName'
  | 'copyDdl'
  | 'bookmark'
  | 'filter'
  | 'refresh'
  | 'open'
  | 'viewData'
  | 'newScript'
  | 'deleteScript';
