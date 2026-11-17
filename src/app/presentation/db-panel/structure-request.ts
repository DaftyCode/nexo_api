import { NavigatorRow } from '../../domain/db/rows';
import type { DbSection } from './section';
import type { StructureRequest } from './structure-draft';

/** Whether the driver of a connection edits the structure of its tables. */
export function editsStructure(section: DbSection, connection: string | undefined) {
  return (
    !!connection && (section.drivers.capabilities(connection)?.methods ?? []).includes('ddl.plan')
  );
}

/** Opens the table editor on a table of the tree, or on its folder of tables to create one. */
export function openStructure(
  section: DbSection,
  row: NavigatorRow,
  mode: StructureRequest['mode'],
) {
  if (!row.connection || !row.path) return;
  section.structureRequest.set({
    connection: row.connection,
    path: row.path,
    mode,
    name: mode === 'create' ? '' : row.label,
  });
}
