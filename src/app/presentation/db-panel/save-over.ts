import { failureCode } from '../../application/ports';
import { WorkspaceDocument } from '../../domain/models';
import type { DbSection } from './section';

/** Saves a change of a connection; one changed elsewhere is saved over its latest version. */
export async function saveOver(
  section: DbSection,
  document: WorkspaceDocument,
  change: (latest: WorkspaceDocument) => Promise<WorkspaceDocument>,
) {
  try {
    return await change(document);
  } catch (error) {
    if (failureCode(error) !== 'conflict') throw error;
    await section.state.refresh();
    const latest = section.connection(document.id);
    if (!latest) throw error;
    return change(latest);
  }
}
