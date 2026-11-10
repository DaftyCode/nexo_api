import { WorkspaceDocument } from './models';

/** A problem the linter found. `rule` names the message; `line` is where it starts. */
export interface ApiFinding {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  params: string[];
  pointer: string;
  line?: number;
}
export interface ApiParameter {
  name: string;
  in: string;
  required: boolean;
  type: string;
  pointer: string;
  line?: number;
}
export interface ApiOperation {
  method: string;
  operationId: string;
  summary: string;
  deprecated: boolean;
  pointer: string;
  line?: number;
  parameters: ApiParameter[];
  requestBody: {
    required: boolean;
    media: string[];
    schema: string;
    pointer: string;
    line?: number;
  } | null;
  responses: {
    status: string;
    description: string;
    schema: string;
    pointer: string;
    line?: number;
  }[];
}
export interface ApiPath {
  path: string;
  pointer: string;
  line?: number;
  operations: ApiOperation[];
}
export interface ApiOutline {
  title: string;
  version: string;
  paths: ApiPath[];
  schemas: { name: string; type: string; pointer: string; line?: number }[];
}
/** What `api.inspect` returns: the version found, the findings and the outline. */
export interface ApiInspection {
  version: string;
  findings: ApiFinding[];
  outline: ApiOutline | null;
}
export interface ApiEndpoint {
  method: string;
  path: string;
  pointer: string;
  line?: number | null;
}
export interface ApiChange {
  rule: string;
  params: string[];
  breaking: boolean;
  pointer: string;
  /** Whether the pointer is in the earlier version (`base`) or the later one. */
  side: 'base' | 'source';
  line?: number | null;
}
/** What `api.diff` returns. */
export interface ApiDiff {
  breaking: number;
  added: ApiEndpoint[];
  removed: ApiEndpoint[];
  changed: (ApiEndpoint & { changes: ApiChange[] })[];
}

/** The text of a stored definition. */
export function definitionSource(document: WorkspaceDocument | undefined): string {
  const value = document?.value as { source?: unknown } | undefined;
  return typeof value?.source === 'string' ? value.source : '';
}

/** Parameters of a translated message: `{v0, v1, …}`. */
export function messageParams(params: readonly string[]): Record<string, string> {
  return Object.fromEntries(params.map((value, index) => [`v${index}`, value]));
}

/** Counts of findings by severity. */
export function findingCounts(findings: readonly ApiFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
  };
}

/**
 * The paths whose path, methods, operation IDs, summaries or parameters contain the query,
 * with only the matching operations when the path itself does not match.
 */
export function searchOutline(paths: readonly ApiPath[], query: string): ApiPath[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...paths];
  const has = (text: string) => text.toLowerCase().includes(needle);
  return paths.flatMap((path) => {
    if (has(path.path)) return [path];
    const operations = path.operations.filter(
      (operation) =>
        has(operation.method) ||
        has(operation.operationId) ||
        has(operation.summary) ||
        operation.parameters.some((parameter) => has(parameter.name)),
    );
    return operations.length ? [{ ...path, operations }] : [];
  });
}
