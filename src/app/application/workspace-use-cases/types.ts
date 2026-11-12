import { ApiPort } from '../ports';
import { ExecutionOperation } from '../operations';
import { PayloadOf } from '../payloads';
import { WorkspaceDocument } from '../../domain/models';
import { RequestAncestor, VariableRow } from '../../domain/variables';

/** A token copied from the browser, with its refresh token to renew it. */
export interface PastedOAuth2Token {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

/** An operation and its payload without the workspace, which `execute` adds. */
export type WorkspaceExecuteArgs = {
  [O in ExecutionOperation]: [operation: O, payload?: Omit<PayloadOf<O>, 'workspace'>];
}[ExecutionOperation];

/** Variable scopes and inherited configuration used to execute a request. */
export interface ExecutionContext {
  /** Workspace that scopes the execution, such as its cookie jar. */
  workspace?: string;
  environment: readonly VariableRow[];
  globals: readonly VariableRow[];
  ancestors: readonly RequestAncestor[];
}

/** Documents whose variables scripts may update after an execution. */
export interface VariableTargets {
  environment?: WorkspaceDocument;
  globals?: WorkspaceDocument;
  collection?: WorkspaceDocument;
  workspace: string;
}

/** Engine output with the final value of every scope. */
export interface ScriptVariables {
  environment?: unknown;
  globals?: unknown;
  collection?: unknown;
}

/** Creates a document of a workspace; a name is required. */
export function createDocument(
  api: ApiPort,
  id: string,
  workspace: string,
  kind: string,
  name: string,
  value: unknown,
): Promise<WorkspaceDocument> {
  if (!name.trim()) throw new Error('A name is required');
  return api.save({
    id,
    workspace_id: workspace,
    kind,
    name: name.trim(),
    revision: 0,
    updated_at: 0,
    value,
  });
}
