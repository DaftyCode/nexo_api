/**
 * Nexo's own file of connections (DB-25): the SQL connections chosen, with the SSH and proxy
 * profiles and the connection types of the person's own they name, and never a secret: no
 * password, no client key, no password of a proxy. Importing it gives each document a new id
 * and asks for the passwords that did not come.
 */
import type { WorkspaceDocument } from '../../models';
import { sshSecret } from '../../ssh';
import { CONNECTION_TYPES, DbConnectionValue, isDbConnection } from '../connection';
import { ConnectionImport, ImportBuilder, ImportedDocument } from './builder';

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const KINDS = ['ssh-profile', 'proxy-profile', 'connection-type'] as const;
type NamedKind = (typeof KINDS)[number];

/** A connection's value without its secrets: one that kept a password now asks for it. */
function withoutSecrets(value: DbConnectionValue): DbConnectionValue {
  const { password, ...rest } = value;
  const kept: DbConnectionValue = { ...rest };
  if (password && !kept.pgpass) kept.askPassword = true;
  if (kept.tls) {
    const { keyPem: _key, ...tls } = kept.tls;
    kept.tls = tls;
  }
  if (kept.route) {
    const { password: _password, ...route } = kept.route;
    kept.route = route;
  }
  return kept;
}

/** The file of the connections `chosen`, among a workspace's `documents`. */
export function exportConnections(
  documents: readonly WorkspaceDocument[],
  chosen: readonly string[],
): string {
  const connections = documents.filter(
    (document) => isDbConnection(document) && chosen.includes(document.id),
  );
  const named = new Set<string>();
  for (const connection of connections) {
    const value = connection.value as DbConnectionValue;
    if (value.route?.profile) named.add(value.route.profile);
    if (value.type && !CONNECTION_TYPES.includes(value.type)) named.add(value.type);
  }
  const profiles = documents
    .filter((document) => named.has(document.id) && KINDS.includes(document.kind as NamedKind))
    .map((document) => {
      const value = { ...(document.value as Json) };
      // The names of vault secrets do not travel: their values stay here.
      delete value['secret'];
      delete value['passphraseSecret'];
      return { id: document.id, kind: document.kind, name: document.name, value };
    });
  const file = {
    nexo: 'connections',
    version: 1,
    connections: connections.map((document) => ({
      id: document.id,
      name: document.name,
      value: withoutSecrets(document.value as DbConnectionValue),
    })),
    profiles,
  };
  return JSON.stringify(file, null, 2) + '\n';
}

export function readNexoConnections(file: Json, builder: ImportBuilder): ConnectionImport {
  if (file['version'] !== 1) throw new Error('Nexo does not know the connections of this file');
  const ids = new Map<string, string>();
  for (const entry of Array.isArray(file['profiles']) ? file['profiles'] : []) {
    const profile = record(entry);
    const kind = profile['kind'] as NamedKind;
    if (!KINDS.includes(kind) || typeof profile['id'] !== 'string') continue;
    const id = builder.newId();
    ids.set(profile['id'], id);
    const value = { ...record(profile['value']) };
    const name = String(profile['name'] ?? '');
    if (kind === 'ssh-profile') {
      value['secret'] = sshSecret(id);
      builder.note(value['auth'] === 'key' ? 'sshKey' : 'sshPassword', name);
    }
    if (kind === 'proxy-profile' && value['username']) builder.note('proxyPassword', name);
    builder.add({ id, kind, name, value } satisfies ImportedDocument);
  }
  for (const entry of Array.isArray(file['connections']) ? file['connections'] : []) {
    const connection = record(entry);
    const value = record(connection['value']) as unknown as DbConnectionValue;
    if (typeof value.driver !== 'string') continue;
    const name = String(connection['name'] ?? value.driver);
    const kept = withoutSecrets(value);
    if (kept.route?.profile)
      kept.route = { ...kept.route, profile: ids.get(kept.route.profile) ?? kept.route.profile };
    if (kept.type && ids.has(kept.type)) kept.type = ids.get(kept.type);
    if (kept.route?.via === 'socks5' && kept.route.username && !kept.route.profile)
      builder.note('proxyPassword', name);
    builder.connection(name, kept);
  }
  return builder.result();
}
