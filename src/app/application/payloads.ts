// Generated from backend/crates/nexo-application/src/payloads.rs.
// Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.
import type { ExecutionOperation } from './operations';

export interface VariableRow {
  key: string;
  value?: unknown;
  enabled?: boolean;
  disabled?: boolean;
  type?: string;
  [field: string]: unknown;
}

export interface ExecutionContext {
  ancestors?: readonly object[];
}

export interface RunCursor {
  results?: number;
  assertions?: number;
  logs?: number;
}

export interface GitFile {
  id: string;
  value: unknown;
}

export interface RequestPayload {
  workspace?: string;
  id?: string;
  request?: object;
  item?: object;
  collection?: object;
  variables?: readonly VariableRow[];
  globals?: readonly VariableRow[];
  context?: ExecutionContext;
  timeout?: number;
  strictSSL?: boolean;
  followRedirects?: boolean;
  trustRedirectCredentials?: boolean;
  transport?: unknown;
}

export interface RunPayload {
  workspace?: string;
  action?: 'status';
  id?: string;
  after?: RunCursor;
  request?: object;
  item?: object;
  collection?: object;
  variables?: readonly VariableRow[];
  globals?: readonly VariableRow[];
  context?: ExecutionContext;
  data?: readonly unknown[];
  iterations?: number;
  globalTimeout?: number;
  timeout?: number;
  strictSSL?: boolean;
  followRedirects?: boolean;
  trustRedirectCredentials?: boolean;
  transport?: unknown;
}

export interface IdPayload {
  id: string;
  workspace?: string;
}

export interface ImportPayload {
  content: string;
  workspace?: string;
}

export interface CodegenPayload {
  workspace?: string;
  request?: object;
  language?: string;
  variant?: string;
  followRedirects?: boolean;
}

export interface RealtimeConnectPayload {
  workspace?: string;
  protocol?: string;
  url?: string;
  headers?: Record<string, string> | readonly object[];
  subprotocols?: readonly string[];
  path?: string;
  auth?: Record<string, unknown>;
  clientId?: string;
  clean?: boolean;
  username?: string;
  password?: string;
  topic?: string;
  qos?: number;
  strictSSL?: boolean;
  caPem?: string;
  certPem?: string;
  keyPem?: string;
}

export interface RealtimeSendPayload {
  id: string;
  workspace?: string;
  action?: string;
  message?: unknown;
  topic?: string;
  event?: string;
  qos?: number;
  retain?: boolean;
}

export interface RealtimePollPayload {
  id: string;
  workspace?: string;
  after?: number;
}

export interface WorkspacePayload {
  workspace?: string;
}

export interface GrpcPayload {
  workspace?: string;
  url?: string;
  proto?: string;
  service?: string;
  method?: string;
  tls?: boolean;
  caPem?: string;
  certPem?: string;
  keyPem?: string;
  message?: unknown;
  messages?: readonly unknown[];
  metadata?: unknown;
  timeout?: number;
}

export interface MockStartPayload {
  workspace?: string;
  id?: string;
  port?: number;
  examples?: readonly object[];
}

export interface DatasetQueryPayload {
  id: string;
  sql: string;
  workspace?: string;
}

export interface DatasetRowsPayload {
  workspace?: string;
  id?: string;
  content?: string;
  rows?: readonly unknown[];
}

export interface McpRequestPayload {
  workspace?: string;
  url?: string;
  method?: string;
  params?: unknown;
  headers?: Record<string, string> | readonly object[];
  sessionId?: string;
}

export interface OauthTokenPayload {
  url: string;
  workspace?: string;
  fields?: Record<string, unknown>;
  headers?: Record<string, string> | readonly object[];
}

export interface Oauth2TokenPayload {
  workspace?: string;
  tokenId?: string;
  request?: object;
  item?: object;
  collection?: object;
  variables?: readonly VariableRow[];
  globals?: readonly VariableRow[];
  context?: ExecutionContext;
}

export interface Oauth2AuthorizePayload {
  workspace?: string;
  action?: 'start' | 'status' | 'open' | 'complete' | 'cancel';
  session?: string;
  url?: string;
  openBrowser?: boolean;
  request?: object;
  item?: object;
  collection?: object;
  variables?: readonly VariableRow[];
  globals?: readonly VariableRow[];
  context?: ExecutionContext;
}

export interface Oauth2TokensPayload {
  workspace?: string;
  action?: 'list' | 'details' | 'delete' | 'add';
  id?: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
}

export interface PerformancePayload {
  workspace?: string;
  action?: 'status';
  id?: string;
  request?: object;
  users?: number;
  duration?: number;
  profile?: string;
  variables?: readonly VariableRow[];
  globals?: readonly VariableRow[];
  context?: ExecutionContext;
  strictSSL?: boolean;
  followRedirects?: boolean;
}

export interface GitPayload {
  workspace?: string;
  branch?: string;
  message?: string;
  files?: readonly GitFile[];
}

/** The payload of each execution operation, checked by the backend. */
export interface OperationPayloads {
  request: RequestPayload;
  run: RunPayload;
  cancel: IdPayload;
  import: ImportPayload;
  codegen: CodegenPayload;
  'realtime.connect': RealtimeConnectPayload;
  'realtime.send': RealtimeSendPayload;
  'realtime.close': IdPayload;
  'realtime.poll': RealtimePollPayload;
  'realtime.list': WorkspacePayload;
  grpc: GrpcPayload;
  'mock.start': MockStartPayload;
  'mock.stop': IdPayload;
  'mock.list': WorkspacePayload;
  'dataset.query': DatasetQueryPayload;
  'dataset.import': DatasetRowsPayload;
  'dataset.schema': IdPayload;
  'dataset.parse': DatasetRowsPayload;
  'dataset.delete': IdPayload;
  'mcp.request': McpRequestPayload;
  'oauth.token': OauthTokenPayload;
  'oauth2.token': Oauth2TokenPayload;
  'oauth2.authorize': Oauth2AuthorizePayload;
  'oauth2.tokens': Oauth2TokensPayload;
  'cookies.list': WorkspacePayload;
  'cookies.clear': WorkspacePayload;
  performance: PerformancePayload;
  'performance.cancel': IdPayload;
}

/** The payload of an operation. */
export type PayloadOf<O extends ExecutionOperation> = OperationPayloads[O];
