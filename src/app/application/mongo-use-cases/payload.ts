import { DocumentRepositoryPort, ExecutionPort, SecretVaultPort } from '../ports';
import type { MongoConnection } from '../payloads';
import { WorkspaceDocument } from '../../domain/models';
import { BuiltQuery } from '../../domain/mongo-query';
import { MongoConnectionValue, connectionValue } from '../../domain/mongo';
import { VariableScopes, resolveVariables } from '../../domain/variables';

/** What the MongoDB use cases need: the engine, the connection documents and the vault. */
export type MongoPorts = ExecutionPort &
  Pick<DocumentRepositoryPort, 'save' | 'remove' | 'document'> &
  Pick<SecretVaultPort, 'putSecret' | 'removeSecret'>;

/** Secrets typed in the form, not saved yet. Blank keeps what is stored. */
export interface TypedSecrets {
  password?: string;
  keyPem?: string;
}

/** The vault entries Nexo creates for a connection. */
export const passwordSecret = (id: string) => `mongo-password:${id}`;
export const keySecret = (id: string) => `mongo-key:${id}`;

/** What a write did; `change` names the record that undoes it. */
export interface WriteAnswer {
  matched: number;
  modified: number;
  deleted: number;
  inserted: unknown[];
  change: string;
}

/** Where a query runs. */
export interface QueryTarget {
  database: string;
  collection: string;
}

/** Where a write goes, and its write concern when it is not the connection's. */
export interface WriteWhere extends QueryTarget {
  writeConcern?: Record<string, unknown>;
}

/** What an explain describes: a query of the query bar, or an aggregation pipeline. */
export type ExplainedQuery =
  | { query: BuiltQuery }
  | {
      pipeline: Record<string, unknown>[];
      collation?: Record<string, unknown>;
      hint?: string | Record<string, unknown>;
    };

/**
 * A connection as the backend receives it: variables of the active environment replaced,
 * vault references kept for the backend, and secrets typed but not saved yet used as typed.
 */
export function connectionPayload(
  value: MongoConnectionValue,
  scopes: VariableScopes,
  typed: TypedSecrets = {},
): MongoConnection {
  const resolve = (text: string | undefined) =>
    text?.trim() ? resolveVariables(text, scopes) : undefined;
  const connection: MongoConnection = {
    uri: resolve(value.uri) ?? '',
    password: typed.password || value.password,
    caPem: resolve(value.caPem),
    certPem: resolve(value.certPem),
    keyPem: typed.keyPem?.trim() || value.keyPem,
  };
  for (const key of Object.keys(connection) as (keyof MongoConnection)[])
    if (connection[key] === undefined) delete connection[key];
  return connection;
}

/** A saved connection as the backend receives it. */
export function savedConnection(
  connection: WorkspaceDocument,
  scopes: VariableScopes,
): MongoConnection {
  return connectionPayload(connectionValue(connection.value), scopes);
}

/** The saved connection a change names: the backend refuses it when it is read-only. */
export function writer(workspace: string, connection: WorkspaceDocument, scopes: VariableScopes) {
  return {
    workspace,
    connection: savedConnection(connection, scopes),
    connectionId: connection.id,
  };
}

/** The target of a write, with its write concern only when one is set. */
export function where({ database, collection, writeConcern }: WriteWhere) {
  return { database, collection, ...(writeConcern ? { writeConcern } : {}) };
}
