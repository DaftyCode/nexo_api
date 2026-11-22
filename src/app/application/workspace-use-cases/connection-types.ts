import {
  ConnectionTypeChoice,
  ConnectionTypeForm,
  connectionTypeValue,
  connectionTypes,
} from '../../domain/db/connection-types';
import { WorkspaceDocument } from '../../domain/models';
import { ApiPort } from '../ports';

/**
 * The types of SQL connections of the person's own (DB-25): workspace documents with their
 * color and the rules their sessions keep, which the engine applies.
 */
export class ConnectionTypeCases {
  constructor(private readonly api: Pick<ApiPort, 'save' | 'remove'>) {}

  /** The person's own types, by name. */
  own(documents: readonly WorkspaceDocument[]): ConnectionTypeChoice[] {
    return connectionTypes(documents).filter((type) => !type.builtin);
  }

  /** The connections that have a type: it cannot be deleted while they do. */
  users(id: string, documents: readonly WorkspaceDocument[]): WorkspaceDocument[] {
    return documents.filter(
      (document) =>
        document.kind === 'connection' &&
        (document.value as { type?: unknown } | undefined)?.type === id,
    );
  }

  /** Saves a type with its revision; `existing` is the version it was loaded from. */
  save(
    workspace: string,
    id: string,
    form: ConnectionTypeForm,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'connection-type',
      name: form.name.trim(),
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: connectionTypeValue(form),
    });
  }

  remove(document: WorkspaceDocument) {
    return this.api.remove(document);
  }
}
