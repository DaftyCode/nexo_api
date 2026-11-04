// Generated from backend/crates/nexo-application/src/operations.rs.
// Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.
export const EXECUTION_OPERATIONS = [
  'request',
  'run',
  'cancel',
  'import',
  'codegen',
  'realtime.connect',
  'realtime.send',
  'realtime.close',
  'realtime.poll',
  'realtime.list',
  'grpc',
  'mock.start',
  'mock.stop',
  'mock.list',
  'dataset.query',
  'dataset.import',
  'dataset.schema',
  'dataset.parse',
  'dataset.delete',
  'mcp.request',
  'oauth.token',
  'cookies.list',
  'cookies.clear',
  'performance',
  'performance.cancel',
] as const;
export type ExecutionOperation = (typeof EXECUTION_OPERATIONS)[number];
export const GIT_OPERATIONS = [
  'init',
  'status',
  'diff',
  'log',
  'branches',
  'checkout',
  'branch',
  'commit',
  'stash',
  'export',
] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];
