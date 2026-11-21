import { NavigatorRow } from '../../domain/db/rows';
import type { DbSection } from './section';

/** Opens the comparison of a schema, database or table with another one (DB-24). */
export function openCompare(section: DbSection, row: NavigatorRow) {
  if (!row.connection) return;
  section.tabs.open({
    kind: 'compare',
    connection: row.connection,
    path: row.path ?? [],
    part: row.node?.kind === 'table' ? 'table' : 'schema',
    title: 'Compare',
  });
}

/** Opens the backups, restores and scripts with the local client tools (DB-23). */
export function openNative(section: DbSection, row: NavigatorRow) {
  if (!row.connection) return;
  section.tabs.open({ kind: 'native', connection: row.connection, title: 'Backup and restore' });
}
