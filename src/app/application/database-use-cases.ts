import { DatabaseConnectionCases, DatabasePorts } from './database-use-cases/connections';
import { DatabaseNavigatorCases } from './database-use-cases/navigator';
import { DatabaseStatementCases, StatementPorts } from './database-use-cases/statements';
import { PreferencePort } from './ports';

export { DatabaseConnectionCases, DatabaseNavigatorCases, DatabaseStatementCases };
export {
  connectionVariables,
  testedServers,
  type DatabasePorts,
  type DbDestination,
  type DbTestReport,
  type TypedDbSecrets,
} from './database-use-cases/connections';
export { treeSession, type DbServerInfo, type DriverHello } from './database-use-cases/navigator';
export {
  editorSession,
  type ScriptFailure,
  type TransactionState,
} from './database-use-cases/statements';

/** Preferences kept in memory, where no device storage is given. */
function memory(): PreferencePort {
  const values = new Map<string, string>();
  return { read: (key) => values.get(key), write: (key, value) => void values.set(key, value) };
}

/**
 * The database section's use cases, by area: saved connections with their secrets in the
 * vault, the navigator with its sessions, and the SQL editor.
 */
export class DatabaseUseCases {
  readonly connections: DatabaseConnectionCases;
  readonly navigator: DatabaseNavigatorCases;
  readonly statements: DatabaseStatementCases;

  constructor(api: DatabasePorts & StatementPorts, preferences: PreferencePort = memory()) {
    this.connections = new DatabaseConnectionCases(api);
    this.navigator = new DatabaseNavigatorCases(api);
    this.statements = new DatabaseStatementCases(api, preferences);
  }
}
