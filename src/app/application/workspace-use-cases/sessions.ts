import { ApiPort, PreferencePort, failureCode } from '../ports';
import { RequestTab, WorkspaceDocument } from '../../domain/models';
import {
  WorkspaceSession,
  readSession,
  restoreTabs,
  sessionId,
  sessionOf,
} from '../../domain/workspace-session';

const restorePreference = 'session.restoreTabs';

/**
 * What a workspace shows when it opens again: its tabs, with their unsaved changes, and the
 * order of its collections. Kept by the engine in the workspace (never in the browser, as
 * drafts may hold credentials), one `session` document per workspace.
 */
export class SessionCases {
  constructor(
    private readonly api: ApiPort,
    private readonly preferences: PreferencePort,
  ) {}

  /** Whether the tabs open again with the workspace; on unless turned off on this device. */
  restoresTabs() {
    return this.preferences.read(restorePreference) !== 'off';
  }
  setRestoresTabs(restore: boolean) {
    this.preferences.write(restorePreference, restore ? '' : 'off');
  }
  /** The session stored among the documents of a workspace, if any. */
  stored(documents: readonly WorkspaceDocument[]) {
    const document = documents.find((d) => d.kind === 'session');
    return document
      ? { session: readSession(document.value), revision: document.revision }
      : undefined;
  }
  /** The session of these tabs; only the order of the collections when tabs do not reopen. */
  of(
    tabs: readonly RequestTab[],
    activeTab: string,
    collections: readonly string[],
    documents: readonly WorkspaceDocument[],
  ) {
    return sessionOf(tabs, activeTab, collections, documents, this.restoresTabs());
  }
  /** The tabs of a session, read again from their collections; `dropped` were deleted. */
  tabs(session: WorkspaceSession, documents: readonly WorkspaceDocument[], id: () => string) {
    return restoreTabs(session, documents, id);
  }
  /**
   * Saves the session over the stored one and returns its new revision. Only its last state
   * matters: a revision changed elsewhere (another window) is saved over.
   */
  async save(workspace: string, session: WorkspaceSession, revision: number) {
    const document: WorkspaceDocument = {
      id: sessionId(workspace),
      workspace_id: workspace,
      kind: 'session',
      name: 'Session',
      revision,
      updated_at: 0,
      value: session,
    };
    try {
      return (await this.api.save(document)).revision;
    } catch (error) {
      if (failureCode(error) !== 'conflict') throw error;
      const current = await this.api.document(document.id);
      return (await this.api.save({ ...document, revision: current.revision })).revision;
    }
  }
}
