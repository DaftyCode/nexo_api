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

/** Payloads the backend checks; the other operations are still being typed. */
export interface OperationPayloads {
  request: RequestPayload;
  run: RunPayload;
}
/** The payload of an operation. */
export type PayloadOf<O extends ExecutionOperation> = O extends keyof OperationPayloads
  ? OperationPayloads[O]
  : Record<string, unknown>;
