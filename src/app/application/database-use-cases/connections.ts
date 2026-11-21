import { WorkspaceDocument } from '../../domain/models';
import {
  DbConnectionValue,
  NodeFilter,
  dbKeySecret,
  dbPasswordSecret,
  dbProxySecret,
  isVaultReference,
  readDbConnection,
  vaultReference,
} from '../../domain/db/connection';
import { VariableScopes, referencedVariables, resolveVariable } from '../../domain/variables';
import { DocumentRepositoryPort, ExecutionPort, SecretVaultPort } from '../ports';

/** What the database use cases need: the engine, the connection documents and the vault. */
export type DatabasePorts = ExecutionPort &
  Pick<DocumentRepositoryPort, 'save' | 'remove'> &
  Pick<SecretVaultPort, 'putSecret' | 'removeSecret'>;

/** Secrets typed in the form, not saved yet. Blank keeps what is stored. */
export interface TypedDbSecrets {
  password?: string;
  keyPem?: string;
  /** Of the SOCKS5 proxy of its route. */
  proxyPassword?: string;
}

/** What «Test the tunnel» says: the server reached through the route, and how long it took. */
export interface DbRouteReport {
  host: string;
  port: number;
  via: 'socks5' | 'ssh';
  ms: number;
}

/** A server the driver asked to reach while testing, and what the egress policy said. */
export interface DbDestination {
  host: string;
  port: number;
  allowed: boolean;
  addresses: string[];
  reason?: string;
}

/** The servers a test reached or was refused, also when it failed (`detail.servers`). */
export function testedServers(detail: unknown): DbDestination[] {
  const servers = (detail as { servers?: unknown } | undefined)?.servers;
  return Array.isArray(servers) ? (servers as DbDestination[]) : [];
}

/** What a server says when a connection is tested. */
export interface DbTestReport {
  server: {
    serverVersion: string;
    product?: string;
    database?: string;
    user?: string;
    tls: boolean;
  };
  pingMs: number;
  servers?: DbDestination[];
}

/**
 * The values of the environment variables a connection names (`{{host}}`), for the backend
 * to put in it. Vault references stay for the backend; a variable without a value is left out
 * and the backend names it.
 */
export function connectionVariables(value: unknown, scopes: VariableScopes) {
  const variables: Record<string, string> = {};
  for (const name of referencedVariables(value)) {
    if (name.startsWith('vault:')) continue;
    const resolved = resolveVariable(name, scopes);
    if (resolved.defined && resolved.value !== undefined) variables[name] = resolved.value;
  }
  return variables;
}

/** Connections of the database modules: workspace documents, their secrets in the vault. */
export class DatabaseConnectionCases {
  constructor(private readonly api: DatabasePorts) {}

  /**
   * The value with the secrets typed in the form moved to the vault, under the names of
   * connection `id`, and only their references kept. A vault reference typed as such stays.
   */
  async withSecrets(
    id: string,
    value: DbConnectionValue,
    typed: TypedDbSecrets,
  ): Promise<DbConnectionValue> {
    const stored: DbConnectionValue = {
      ...value,
      ...(value.tls ? { tls: { ...value.tls } } : {}),
      ...(value.route ? { route: { ...value.route } } : {}),
    };
    // A connection that asks for its password, or reads pgpass, keeps none in the vault.
    const password = value.askPassword || value.pgpass ? '' : (typed.password ?? '');
    if (password) {
      if (isVaultReference(password)) stored.password = password.trim();
      else {
        await this.api.putSecret(dbPasswordSecret(id), password);
        stored.password = vaultReference(dbPasswordSecret(id));
      }
    }
    const key = typed.keyPem?.trim() ?? '';
    if (key && stored.tls) {
      if (isVaultReference(key)) stored.tls.keyPem = key;
      else {
        await this.api.putSecret(dbKeySecret(id), key);
        stored.tls.keyPem = vaultReference(dbKeySecret(id));
      }
    }
    const proxy = typed.proxyPassword ?? '';
    if (proxy && stored.route?.via === 'socks5') {
      if (isVaultReference(proxy)) stored.route.password = proxy.trim();
      else {
        await this.api.putSecret(dbProxySecret(id), proxy);
        stored.route.password = vaultReference(dbProxySecret(id));
      }
    }
    return stored;
  }

  /** Saves a connection with its revision; `existing` is the version it was loaded from. */
  async save(
    workspace: string,
    id: string,
    name: string,
    value: DbConnectionValue,
    typed: TypedDbSecrets,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    const stored = await this.withSecrets(id, value, typed);
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'connection',
      name: name.trim() || 'Database',
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: stored,
    });
  }

  /**
   * Tests a connection as the form shows it, without saving it: typed secrets go to the vault
   * first (the backend refuses them in the clear), and the variables it names are sent.
   */
  async test(
    workspace: string,
    id: string,
    value: DbConnectionValue,
    typed: TypedDbSecrets,
    scopes: VariableScopes,
  ): Promise<DbTestReport> {
    const connection = await this.withSecrets(id, value, typed);
    // The password typed in the form tests a connection that asks for it, and is not kept.
    const asked = value.askPassword && typed.password ? { password: typed.password } : {};
    return this.api.execute<DbTestReport>('db.test', {
      workspace,
      connection: connection as unknown as Record<string, unknown>,
      variables: connectionVariables(connection, scopes),
      ...asked,
    });
  }

  /**
   * «Test the tunnel»: the server of the connection as the form shows it, reached through its
   * SOCKS5 proxy or SSH tunnel without opening a session. `port` is the engine's usual one.
   */
  async testRoute(
    workspace: string,
    id: string,
    value: DbConnectionValue,
    typed: TypedDbSecrets,
    scopes: VariableScopes,
    port?: number,
  ): Promise<DbRouteReport> {
    const connection = await this.withSecrets(id, value, typed);
    return this.api.execute<DbRouteReport>('db.route.test', {
      workspace,
      connection: connection as unknown as Record<string, unknown>,
      variables: connectionVariables(connection, scopes),
      ...(port ? { port } : {}),
    });
  }

  /** A copy of a connection, with a new id and name; it reads the same vault entries. */
  duplicate(workspace: string, document: WorkspaceDocument, id: string, name: string) {
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'connection',
      name,
      revision: 0,
      updated_at: 0,
      value: structuredClone(document.value),
    });
  }

  /** Saves a change of a saved connection: its folder, its name or its filters. */
  update(document: WorkspaceDocument, name: string, value: DbConnectionValue) {
    return this.api.save({ ...document, name, value });
  }

  moveTo(document: WorkspaceDocument, folder: string) {
    const value = readDbConnection(document.value);
    const moved = { ...(document.value as object), folder: folder.trim() } as DbConnectionValue;
    if (!folder.trim()) delete moved.folder;
    return value.folder === (folder.trim() || undefined)
      ? Promise.resolve(document)
      : this.update(document, document.name, moved);
  }

  setFilters(document: WorkspaceDocument, filters: NodeFilter[]) {
    const value = { ...(document.value as object), filters } as DbConnectionValue;
    if (!filters.length) delete value.filters;
    return this.update(document, document.name, value);
  }

  /** Removes the vault entries a connection that was tested but never saved left behind. */
  async forget(id: string) {
    for (const name of [dbPasswordSecret(id), dbKeySecret(id), dbProxySecret(id)])
      await this.api.removeSecret(name).catch(() => undefined);
  }

  /**
   * Deletes a connection and the vault entries Nexo created for it, unless another connection
   * (a duplicate) still reads them.
   */
  async remove(document: WorkspaceDocument, others: readonly WorkspaceDocument[]) {
    await this.api.remove(document);
    const text = (item: WorkspaceDocument) => JSON.stringify(item.value ?? {});
    for (const name of [
      dbPasswordSecret(document.id),
      dbKeySecret(document.id),
      dbProxySecret(document.id),
    ]) {
      const reference = vaultReference(name);
      const used = others.some((other) => other.id !== document.id && text(other).includes(name));
      if (text(document).includes(reference) && !used)
        await this.api.removeSecret(name).catch(() => undefined);
    }
  }
}
