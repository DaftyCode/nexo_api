import { DocumentRepositoryPort, ExecutionPort, SecretVaultPort } from './ports';
import { WorkspaceDocument } from '../domain/models';
import {
  ConnectionReport,
  ImportedConnection,
  MongoConnectionValue,
  connectionValue,
  isVaultReference,
  parseCompassExport,
} from '../domain/mongo';
import { VariableScopes, resolveVariable } from '../domain/variables';

type MongoPorts = ExecutionPort &
  Pick<DocumentRepositoryPort, 'save' | 'remove'> &
  Pick<SecretVaultPort, 'putSecret' | 'removeSecret'>;

/** Secrets typed in the form, not saved yet. Blank keeps what is stored. */
export interface TypedSecrets {
  password?: string;
  keyPem?: string;
}

/** The vault entries Nexo creates for a connection. */
export const passwordSecret = (id: string) => `mongo-password:${id}`;
export const keySecret = (id: string) => `mongo-key:${id}`;

/** Replaces environment, collection and global variables; vault references stay for the backend. */
export function resolveVariables(text: string, scopes: VariableScopes, depth = 0): string {
  if (depth > 5) return text;
  const result = text.replace(/\{\{([^{}]+)\}\}/g, (match, raw: string) => {
    const variable = resolveVariable(raw.trim(), scopes);
    if (variable.scope === 'vault' || variable.scope === 'dynamic') return match;
    return variable.defined && variable.value !== undefined ? variable.value : match;
  });
  return result === text ? result : resolveVariables(result, scopes, depth + 1);
}

/** MongoDB connections: kept as workspace documents, their secrets in the vault. */
export class MongoUseCases {
  constructor(
    private readonly api: MongoPorts,
    private readonly id: () => string,
  ) {}

  /**
   * Saves a connection. A password or key typed in the form goes to the vault, under a name
   * of this connection, and the document keeps only its reference.
   */
  async save(
    workspace: string,
    name: string,
    value: MongoConnectionValue,
    typed: TypedSecrets,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    const id = existing?.id ?? this.id();
    const stored: MongoConnectionValue = { ...value };
    const password = typed.password ?? '';
    if (password) {
      if (isVaultReference(password)) stored.password = password.trim();
      else {
        await this.api.putSecret(passwordSecret(id), password);
        stored.password = `{{vault:${passwordSecret(id)}}}`;
      }
    }
    const key = typed.keyPem?.trim() ?? '';
    if (key) {
      if (isVaultReference(key)) stored.keyPem = key;
      else {
        await this.api.putSecret(keySecret(id), key);
        stored.keyPem = `{{vault:${keySecret(id)}}}`;
      }
    }
    for (const field of ['password', 'caPem', 'certPem', 'keyPem', 'folder', 'color'] as const)
      if (!stored[field]?.trim()) delete stored[field];
    if (!stored.readOnly) delete stored.readOnly;
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'connection',
      name: name.trim() || 'MongoDB',
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: stored,
    });
  }

  /** Deletes a connection and the secrets Nexo created for it. */
  async remove(document: WorkspaceDocument) {
    await this.api.remove(document);
    const value = connectionValue(document.value);
    for (const [field, name] of [
      ['password', passwordSecret(document.id)],
      ['keyPem', keySecret(document.id)],
    ] as const) {
      if (value[field]?.includes(name)) await this.api.removeSecret(name).catch(() => undefined);
    }
  }

  /**
   * Tests a connection as the form shows it: variables of the active environment are
   * replaced, and secrets typed but not saved yet are used as they are.
   */
  test(
    workspace: string,
    value: MongoConnectionValue,
    typed: TypedSecrets,
    scopes: VariableScopes,
  ): Promise<ConnectionReport> {
    const resolve = (text: string | undefined) =>
      text?.trim() ? resolveVariables(text, scopes) : undefined;
    const connection = {
      uri: resolve(value.uri) ?? '',
      password: typed.password || value.password,
      caPem: resolve(value.caPem),
      certPem: resolve(value.certPem),
      keyPem: typed.keyPem?.trim() || value.keyPem,
    };
    for (const key of Object.keys(connection) as (keyof typeof connection)[])
      if (connection[key] === undefined) delete connection[key];
    return this.api.execute<ConnectionReport>('mongo.test', { workspace, connection });
  }

  /** Connections of a MongoDB Compass export, saved with their passwords in the vault. */
  async importCompass(workspace: string, text: string): Promise<WorkspaceDocument[]> {
    const connections: ImportedConnection[] = parseCompassExport(text);
    if (!connections.length) throw new Error('The file has no connections');
    const saved: WorkspaceDocument[] = [];
    for (const connection of connections) {
      saved.push(
        await this.save(
          workspace,
          connection.name,
          { uri: connection.uri, ...(connection.color ? { color: connection.color } : {}) },
          { password: connection.password },
        ),
      );
    }
    return saved;
  }
}
