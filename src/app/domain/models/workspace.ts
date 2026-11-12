/** Workspaces, their documents, runs, tabs and collections. */

import type { Assertion, ExecutionResponse, RequestDraft } from './requests';

export interface WorkspaceDocument {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  revision: number;
  updated_at: number;
  value: unknown;
}
export interface Workspace {
  id: string;
  name: string;
}
/** Service status. `mode` is `desktop` in the app window and `web` in a browser. */
export interface Health {
  name: string;
  version: string;
  mode: 'desktop' | 'web';
  engineReady: boolean;
}
export interface Run {
  id: string;
  state: string;
  results: ExecutionResponse[];
  assertions: Assertion[];
  logs: unknown[];
  error?: string;
  duration?: number;
  environment?: unknown;
  globals?: unknown;
  collectionVariables?: unknown;
  /** Totals so far; send them back to receive only newer entries. */
  counts?: RunCounts;
}
export interface RunCounts {
  results: number;
  assertions: number;
  logs: number;
}
/** Adds an incremental status update to the run received so far. */
export function mergeRun(previous: Run, update: Run): Run {
  return {
    ...update,
    results: [...previous.results, ...update.results],
    assertions: [...previous.assertions, ...update.assertions],
    logs: [...previous.logs, ...update.logs],
  };
}
export interface RequestTab {
  id: string;
  request: RequestDraft;
  documentId: string;
  path: number[];
  dirty: boolean;
}
export interface CollectionItem {
  id?: string;
  name: string;
  item?: CollectionItem[];
  request?: Record<string, unknown> | string;
  event?: { listen: string; script: { exec: string[] | string } }[];
  [key: string]: unknown;
}
export interface Collection {
  info: { name: string; schema: string; [key: string]: unknown };
  item: CollectionItem[];
  [key: string]: unknown;
}
