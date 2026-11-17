import { KillMode } from '../../domain/db/admin';
import { readDbConnection } from '../../domain/db/connection';
import { NavigatorRow } from '../../domain/db/rows';
import type { DbSection } from './section';

/** Opens the sessions or the locks of a connection's server, once per connection. */
export function openAdmin(section: DbSection, row: NavigatorRow, kind: 'sessions' | 'locks') {
  if (!row.connection) return;
  section.tabs.open({
    kind,
    connection: row.connection,
    title: kind === 'sessions' ? 'Sessions' : 'Locks',
  });
}

/** Whether the driver of a connection lists the sessions and the locks of its server. */
export function administers(section: DbSection, connection: string | undefined) {
  const methods = (connection && section.drivers.capabilities(connection)?.methods) || [];
  return { sessions: methods.includes('sessions'), locks: methods.includes('locks') };
}

/**
 * What can be done to a session of a connection's server: nothing on a read-only
 * connection, else what its driver says.
 */
export function killModes(section: DbSection, connection: string): KillMode[] {
  const document = section.connection(connection);
  if (!document || readDbConnection(document.value).readOnly) return [];
  return section.drivers.capabilities(connection)?.kill ?? [];
}
