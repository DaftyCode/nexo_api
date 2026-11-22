/**
 * pgAdmin's `servers.json` (its «Import/Export Servers»): every server of its groups, with
 * its SSL mode, its pass file and its SSH tunnel. pgAdmin never exports passwords.
 */
import type { DbConnectionValue } from '../connection';
import { tlsModeOf } from '../engines';
import { ConnectionImport, ImportBuilder } from './builder';

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
const number = (value: unknown) => {
  const parsed = Number(text(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export function readPgAdmin(file: Json, builder: ImportBuilder): ConnectionImport {
  for (const [id, entry] of Object.entries(record(file['Servers']))) {
    const server = record(entry);
    const name = text(server['Name']) || `Server ${id}`;
    const parameters = record(server['ConnectionParameters']);
    const mode = tlsModeOf(text(parameters['sslmode'] ?? server['SSLMode']));
    const passFile = text(parameters['passfile'] ?? server['PassFile']);
    if (passFile) builder.note('passFile', name);
    const files = ['sslcert', 'sslkey', 'sslrootcert'].some((key) => text(parameters[key]));
    if (files || text(server['SSLCert']) || text(server['SSLRootCert']))
      builder.note('tlsFiles', name);
    const timeout = number(parameters['connect_timeout'] ?? server['Timeout']);
    let route: DbConnectionValue['route'];
    if (Number(server['UseSSHTunnel']) === 1) {
      const user = text(server['TunnelUsername']);
      if (!user) builder.note('user', name);
      const key = Number(server['TunnelAuthentication']) === 1;
      const host = text(server['TunnelHost']);
      const profile = builder.ssh(host, number(server['TunnelPort']) ?? 22, user, key, name);
      route = { via: 'ssh', profile };
    }
    builder.connection(name, {
      driver: 'postgres',
      host: text(server['Host']) || text(server['HostAddr']),
      port: number(server['Port']),
      database: text(server['MaintenanceDB']) || undefined,
      user: text(server['Username']) || undefined,
      folder: text(server['Group']) || undefined,
      description: text(server['Comment']) || undefined,
      tls: mode && mode !== 'disable' ? { mode } : undefined,
      pgpass: passFile ? true : undefined,
      connectTimeoutSeconds: timeout ? Math.min(timeout, 120) : undefined,
      route,
    });
  }
  return builder.result();
}
