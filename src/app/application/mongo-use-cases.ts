import { resolveVariables } from '../domain/variables';
import { MongoConnectionCases } from './mongo-use-cases/connections';
import { MongoPorts } from './mongo-use-cases/payload';
import { MongoQueryCases } from './mongo-use-cases/queries';
import { MongoTuningCases } from './mongo-use-cases/tuning';
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
export { MongoConnectionCases, MongoQueryCases, MongoTuningCases, MongoWriteCases };

/** MongoDB use cases, by area: connections, queries, writes, and indexes with the profiler. */
export class MongoUseCases {
  readonly connections: MongoConnectionCases;
  readonly queries: MongoQueryCases;
  readonly writes: MongoWriteCases;
  readonly tuning: MongoTuningCases;

  constructor(api: MongoPorts, id: () => string) {
    this.connections = new MongoConnectionCases(api, id);
    this.queries = new MongoQueryCases(api, id);
    this.writes = new MongoWriteCases(api);
    this.tuning = new MongoTuningCases(api);
  }
}
