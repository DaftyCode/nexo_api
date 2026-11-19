import { CONNECTION_COLORS } from './mongo';
import { RequestDraft } from './models';

/**
 * Protected environments, as Studio 3T colours and locks its connections: a colour seen in
 * the workspace bar and the tabs while the environment is active, and a protection. With
 * `confirm` the interface asks before sending what may change data; with `readonly` the
 * engine refuses it, scripts and runs included.
 */
export type EnvironmentProtection = 'none' | 'confirm' | 'readonly';

export const ENVIRONMENT_PROTECTIONS: readonly EnvironmentProtection[] = [
  'none',
  'confirm',
  'readonly',
];

/** The colours an environment can be marked with: the same as connections. */
export const ENVIRONMENT_COLORS = CONNECTION_COLORS;

export interface EnvironmentSettings {
  /** `#rrggbb`, or empty for none. */
  color: string;
  protection: EnvironmentProtection;
}

/** The colour and protection of an environment's stored value; anything unknown is none. */
export function readEnvironmentSettings(value: unknown): EnvironmentSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const color = typeof source['color'] === 'string' ? source['color'] : '';
  const protection = ENVIRONMENT_PROTECTIONS.find((each) => each === source['protection']);
  return {
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : '',
    protection: protection ?? 'none',
  };
}

/** The fields to store: none for what is not set, so plain environments stay as they were. */
export function storedEnvironmentSettings(settings: EnvironmentSettings) {
  return {
    ...(settings.color ? { color: settings.color } : {}),
    ...(settings.protection !== 'none' ? { protection: settings.protection } : {}),
  };
}

/** Methods that only read (RFC 9110); any other may change data. */
const SAFE = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];

/**
 * Whether a GraphQL document defines a mutation: a `mutation` operation at the top level,
 * with comments and strings skipped. The engine reads it the same way.
 */
export function isGraphQLMutation(document: string): boolean {
  const code = document.replace(/#[^\n]*/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  let depth = 0;
  for (const token of code.match(/[A-Za-z0-9_]+|[{}]/g) ?? []) {
    if (token === '{') depth++;
    else if (token === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && token === 'mutation') return true;
  }
  return false;
}

/** Whether sending a request may change data: a method that is not safe, or a mutation. */
export function mayChangeData(request: Pick<RequestDraft, 'method' | 'protocol' | 'body'>) {
  if (request.protocol === 'graphql') return isGraphQLMutation(request.body);
  return !SAFE.includes(request.method.trim().toUpperCase());
}

/** Requests of a collection (or its items) that may change data, by their stored method. */
export function changingRequests(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce<number>((count, item) => {
    if (!item || typeof item !== 'object') return count;
    const entry = item as { item?: unknown; request?: unknown };
    if (Array.isArray(entry.item)) return count + changingRequests(entry.item);
    const request = entry.request;
    if (typeof request === 'string') return count;
    const stored = (request ?? {}) as {
      method?: unknown;
      body?: { mode?: unknown; graphql?: { query?: unknown } };
    };
    const graphql = stored.body?.mode === 'graphql';
    const changes = graphql
      ? isGraphQLMutation(String(stored.body?.graphql?.query ?? ''))
      : !SAFE.includes(String(stored.method ?? 'GET').toUpperCase());
    return count + (changes ? 1 : 0);
  }, 0);
}
