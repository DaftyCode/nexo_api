import { Group } from '../../domain/db/grid/calc';

/** A cell action offered by the screen around the grid, such as the quick filters of DB-08. */
export interface CellAction {
  id: string;
  /** A message key. */
  label: string;
}
/** Groups the rows of the whole source on the server, when the grid shows one table. */
export type GroupingSource = (columns: readonly string[]) => Promise<Group[]>;
