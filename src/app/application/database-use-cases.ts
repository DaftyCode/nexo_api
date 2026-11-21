import { DatabaseAssistCases } from './database-use-cases/assist';
import { DatabaseConnectionCases, DatabasePorts } from './database-use-cases/connections';
import { DatabaseDiagramCases } from './database-use-cases/diagrams';
import { DatabaseAdminCases } from './database-use-cases/admin';
import { DatabaseDashboardCases } from './database-use-cases/dashboards';
import { DatabaseNativeCases } from './database-use-cases/native';
import { DatabaseCompareCases } from './database-use-cases/compare';
import { DatabaseNavigatorCases } from './database-use-cases/navigator';
import { DatabasePlanCases } from './database-use-cases/plans';
import { DatabaseSearchCases } from './database-use-cases/search';
import { DatabaseStructureCases } from './database-use-cases/structure';
import { DatabaseTransferCases } from './database-use-cases/transfer';
import { DatabaseStatementCases, StatementPorts } from './database-use-cases/statements';
import { DbOpenSessions } from './database-use-cases/open-sessions';
import { PageExitPort, PreferencePort } from './ports';

export {
  DatabaseConnectionCases,
  DatabaseNavigatorCases,
  DatabasePlanCases,
  DatabaseStatementCases,
};
export type { ExplainOptions } from './database-use-cases/plans';
export { DatabaseStructureCases } from './database-use-cases/structure';
export { DatabaseDiagramCases } from './database-use-cases/diagrams';
export { DatabaseAdminCases } from './database-use-cases/admin';
export { DatabaseDashboardCases } from './database-use-cases/dashboards';
export {
  DatabaseSearchCases,
  type SearchAnswer,
  type SearchRequest,
} from './database-use-cases/search';
export {
  DatabaseTransferCases,
  type CopyJob,
  type ExportJob,
  type ImportJob,
  type TransferOutcome,
} from './database-use-cases/transfer';
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
  sharedSession,
  type LoggedStatement,
  type PendingTransaction,
  type ScriptFailure,
  type TransactionAction,
  type TransactionLimits,
  type TransactionState,
} from './database-use-cases/statements';

/** Preferences kept in memory, where no device storage is given. */
function memory(): PreferencePort {
  const values = new Map<string, string>();
  return { read: (key) => values.get(key), write: (key, value) => void values.set(key, value) };
}

/**
 * The database section's use cases, by area: saved connections with their secrets in the
 * vault, the navigator with its sessions, the SQL editor and the plans of its statements.
 * Every session they open is closed when the person leaves the page (`exit`).
 */
export class DatabaseUseCases {
  readonly sessions: DbOpenSessions;
  readonly connections: DatabaseConnectionCases;
  readonly navigator: DatabaseNavigatorCases;
  readonly statements: DatabaseStatementCases;
  readonly assist: DatabaseAssistCases;
  readonly plans: DatabasePlanCases;
  readonly transfer: DatabaseTransferCases;
  readonly search: DatabaseSearchCases;
  readonly structure: DatabaseStructureCases;
  readonly diagrams: DatabaseDiagramCases;
  readonly admin: DatabaseAdminCases;
  readonly dashboards: DatabaseDashboardCases;
  /** Backups, restores and scripts with the local client tools (desktop). */
  readonly native: DatabaseNativeCases;
  /** Comparing and synchronizing schemas and data (DB-24). */
  readonly compare: DatabaseCompareCases;

  constructor(
    engine: DatabasePorts & StatementPorts,
    preferences: PreferencePort = memory(),
    exit?: PageExitPort,
  ) {
    const sessions = new DbOpenSessions(engine);
    this.sessions = sessions;
    const api: DatabasePorts & StatementPorts = {
      execute: (...args) => sessions.execute(...args),
      save: (document) => engine.save(document),
      remove: (document) => engine.remove(document),
      document: (id) => engine.document(id),
      putSecret: (name, value, hosts) => engine.putSecret(name, value, hosts),
      removeSecret: (name) => engine.removeSecret(name),
    };
    exit?.onExit(() => sessions.leave(exit) > 0);
    this.connections = new DatabaseConnectionCases(api);
    this.navigator = new DatabaseNavigatorCases(api);
    this.statements = new DatabaseStatementCases(api, preferences);
    this.assist = new DatabaseAssistCases(preferences);
    this.plans = new DatabasePlanCases(api);
    this.transfer = new DatabaseTransferCases(api);
    this.search = new DatabaseSearchCases(api, preferences);
    this.structure = new DatabaseStructureCases(api);
    this.diagrams = new DatabaseDiagramCases(api);
    this.admin = new DatabaseAdminCases(api);
    this.dashboards = new DatabaseDashboardCases(api);
    this.native = new DatabaseNativeCases(api);
    this.compare = new DatabaseCompareCases(api);
  }
}
