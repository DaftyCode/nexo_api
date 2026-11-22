import type { WorkspaceDocument } from '../../domain/models';
import {
  ConnectionImport,
  ImportedDocument,
  exportConnections,
  readConnectionFile,
} from '../../domain/db/import';
import type { DatabasePorts } from './connections';

/** What an import saved, and what the backend refused, with its reason. */
export interface ImportOutcome {
  saved: WorkspaceDocument[];
  refused: { name: string; error: string }[];
}

/**
 * Importing and exporting connections (DB-25): the file is read here, in the interface, and
 * each document is saved as any other, so the backend checks it (no secrets, valid routes).
 */
export class DatabaseConnectionImportCases {
  constructor(
    private readonly api: Pick<DatabasePorts, 'save'>,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** What a file brings, before anything is saved; throws a message when it is none known. */
  read(text: string): ConnectionImport {
    return readConnectionFile(text, this.newId);
  }

  /**
   * Saves what was read, profiles and types first. A connection the backend refuses is told
   * with its reason, and the others are still saved.
   */
  async save(workspace: string, read: ConnectionImport): Promise<ImportOutcome> {
    const outcome: ImportOutcome = { saved: [], refused: [] };
    for (const document of read.documents) {
      try {
        outcome.saved.push(await this.api.save(this.document(workspace, document)));
      } catch (error) {
        outcome.refused.push({
          name: document.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }

  /** The file of the connections chosen, without secrets. */
  export(documents: readonly WorkspaceDocument[], chosen: readonly string[]): string {
    return exportConnections(documents, chosen);
  }

  private document(workspace: string, document: ImportedDocument): WorkspaceDocument {
    return {
      id: document.id,
      workspace_id: workspace,
      kind: document.kind,
      name: document.name,
      revision: 0,
      updated_at: 0,
      value: document.value,
    };
  }
}
