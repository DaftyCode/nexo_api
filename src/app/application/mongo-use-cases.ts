import { resolveVariables } from '../domain/variables';
import { MongoAggregationCases } from './mongo-use-cases/aggregations';
import { MongoConnectionCases } from './mongo-use-cases/connections';
import { MongoPorts } from './mongo-use-cases/payload';
import { MongoQueryCases } from './mongo-use-cases/queries';
import { MongoSchemaCases } from './mongo-use-cases/schema';
import { MongoShellCases } from './mongo-use-cases/shell';
import { PreferencePort } from './ports';
import { MongoTuningCases } from './mongo-use-cases/tuning';
import { MongoTransferCases } from './mongo-use-cases/transfer';
import { MongoWriteCases } from './mongo-use-cases/writes';

export { resolveVariables };
export {
  connectionPayload,
  keySecret,
  passwordSecret,
  type ExplainedQuery,
  type MongoPorts,
  type QueryTarget,
  type TypedSecrets,
  type WriteAnswer,
  type WriteWhere,
} from './mongo-use-cases/payload';
export type { AggregateWritten, BuiltAggregation } from './mongo-use-cases/aggregations';
export type { ValidationAction, ValidationLevel } from './mongo-use-cases/schema';
export {
  MongoAggregationCases,
  MongoConnectionCases,
  MongoQueryCases,
  MongoSchemaCases,
  MongoShellCases,
  MongoTransferCases,
  MongoTuningCases,
  MongoWriteCases,
};
export type * from './mongo-use-cases/transfer-types';

/** Preferences kept in memory, where no device storage is given. */
function memory(): PreferencePort {
  const values = new Map<string, string>();
  return { read: (key) => values.get(key), write: (key, value) => void values.set(key, value) };
}

/**
 * MongoDB use cases, by area: connections, queries, aggregations, writes, indexes with the
 * profiler, schemas, the shell, and imports and exports.
 */
export class MongoUseCases {
  readonly connections: MongoConnectionCases;
  readonly queries: MongoQueryCases;
  readonly aggregations: MongoAggregationCases;
  readonly writes: MongoWriteCases;
  readonly tuning: MongoTuningCases;
  readonly schema: MongoSchemaCases;
  readonly shell: MongoShellCases;
  readonly transfer: MongoTransferCases;

  constructor(api: MongoPorts, id: () => string, preferences: PreferencePort = memory()) {
    this.connections = new MongoConnectionCases(api, id);
    this.queries = new MongoQueryCases(api, id);
    this.aggregations = new MongoAggregationCases(api, id);
    this.writes = new MongoWriteCases(api);
    this.tuning = new MongoTuningCases(api);
    this.schema = new MongoSchemaCases(api);
    this.shell = new MongoShellCases(api, preferences);
    this.transfer = new MongoTransferCases(api, id);
  }
}
