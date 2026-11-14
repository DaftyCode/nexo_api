import { DatabaseConnectionCases, DatabasePorts } from './database-use-cases/connections';
import { DatabaseNavigatorCases } from './database-use-cases/navigator';

export { DatabaseConnectionCases, DatabaseNavigatorCases };
export {
  connectionVariables,
  type DatabasePorts,
  type DbTestReport,
  type TypedDbSecrets,
} from './database-use-cases/connections';
export { treeSession, type DbServerInfo, type DriverHello } from './database-use-cases/navigator';

/**
 * The database section's use cases, by area: saved connections with their secrets in the
 * vault, and the navigator with its sessions.
 */
export class DatabaseUseCases {
  readonly connections: DatabaseConnectionCases;
  readonly navigator: DatabaseNavigatorCases;

  constructor(api: DatabasePorts) {
    this.connections = new DatabaseConnectionCases(api);
    this.navigator = new DatabaseNavigatorCases(api);
  }
}
