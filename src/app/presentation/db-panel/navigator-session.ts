import { treeSession } from '../../application/database-use-cases';
import type { DbSection } from './section';

/**
 * The use cases on the navigator's session of a connection, connecting it first when it is
 * not: what diagrams and the administration of a server read on.
 */
export async function navigatorSession(section: DbSection, id: string) {
  const connection = section.connection(id);
  if (!connection) throw new Error('The connection is no longer there');
  if (section.tree.status()[id] !== 'connected' && !(await section.tree.connect(connection)))
    throw new Error('db.object.offline');
  return {
    cases: await section.cases(),
    workspace: section.state.workspaceId(),
    session: treeSession(id),
  };
}
