import { Collection, CollectionItem, KeyValue, RequestDraft } from './models';

/** A variable row as edited in environments, globals and collections. */
export interface VariableRow {
  key: string;
  value: string;
  enabled: boolean;
  secret: boolean;
}

export type VariableScopeName = 'environment' | 'collection' | 'globals';

/** Values visible to a request, ordered from the narrowest to the broadest scope. */
export interface VariableScopes {
  environment: readonly VariableRow[];
  collection: readonly VariableRow[];
  globals: readonly VariableRow[];
}

export interface ResolvedVariable {
  name: string;
  defined: boolean;
  scope?: VariableScopeName | 'dynamic' | 'vault';
  value?: string;
  secret: boolean;
}

/** Inheritable configuration of the collection and folders above a request. */
export interface RequestAncestor {
  name: string;
  variable?: unknown;
  auth?: unknown;
  event?: unknown;
}

export const dynamicVariables = ['$guid', '$randomUUID', '$timestamp', '$randomInt'] as const;
const sensitiveName = /password|secret|token|api.?key|authorization|credential|private.?key/i;
const placeholder = /\{\{([^{}]+)\}\}/g;
export const redactedMarker = '[REDACTED]';

export function emptyVariable(key = '', value = ''): VariableRow {
  return { key, value, enabled: true, secret: false };
}

/** Accepts the portable `{key,value,enabled|disabled,type}` rows and normalizes them. */
export function toVariableRows(value: unknown): VariableRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    if (typeof row['key'] !== 'string') return [];
    return [
      {
        key: row['key'],
        value: row['value'] == null ? '' : String(row['value']),
        enabled: row['enabled'] !== false && row['disabled'] !== true,
        secret: row['type'] === 'secret' || row['secret'] === true,
      },
    ];
  });
}

/** Rows stored in documents keep the portable shape understood by imports and the engine. */
export function toPortableRows(rows: readonly VariableRow[]) {
  return rows
    .filter((row) => row.key.trim())
    .map((row) => ({
      key: row.key.trim(),
      value: row.value,
      enabled: row.enabled,
      ...(row.secret ? { type: 'secret' } : {}),
    }));
}

/** Collection variables use the collection format: `disabled` instead of `enabled`. */
export function toCollectionVariables(rows: readonly VariableRow[]) {
  return rows
    .filter((row) => row.key.trim())
    .map((row) => ({
      key: row.key.trim(),
      value: row.value,
      ...(row.enabled ? {} : { disabled: true }),
      ...(row.secret ? { type: 'secret' } : {}),
    }));
}

export function isSensitive(row: Pick<VariableRow, 'key' | 'value' | 'secret'>): boolean {
  return row.secret || sensitiveName.test(row.key) || row.value.includes('{{vault:');
}

/** Variable names referenced with `{{name}}` in any string of a value. */
export function referencedVariables(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(placeholder)) names.add(match[1].trim());
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return [...names].filter(Boolean);
}

/** Variables used by the editable parts of a request: URL, params, headers, body and auth. */
export function requestVariables(request: RequestDraft): string[] {
  return referencedVariables([
    request.url,
    request.query.filter((row) => row.enabled),
    request.headers.filter((row) => row.enabled),
    request.bodyMode === 'raw' ? request.body : request.form.filter((row) => row.enabled),
    request.protocol === 'graphql' ? request.graphqlVariables : '',
    request.auth.type === 'inherit' || request.auth.type === 'noauth' ? '' : request.auth,
  ]);
}

function lookup(rows: readonly VariableRow[], name: string): VariableRow | undefined {
  // The last enabled definition wins, matching how the runtime builds its scopes.
  return rows.filter((row) => row.enabled && row.key === name).at(-1);
}

export function resolveVariable(name: string, scopes: VariableScopes): ResolvedVariable {
  if ((dynamicVariables as readonly string[]).includes(name))
    return { name, defined: true, scope: 'dynamic', secret: false };
  if (name.startsWith('vault:'))
    return { name, defined: true, scope: 'vault', value: undefined, secret: true };
  for (const scope of ['environment', 'collection', 'globals'] as const) {
    const row = lookup(scopes[scope], name);
    if (row) return { name, defined: true, scope, value: row.value, secret: isSensitive(row) };
  }
  return { name, defined: false, secret: false };
}

/** Replaces known variables in a preview string; dynamic and vault values stay as placeholders. */
export function previewText(text: string, scopes: VariableScopes, depth = 0): string {
  if (depth > 5) return text;
  const result = text.replace(placeholder, (match, raw: string) => {
    const variable = resolveVariable(raw.trim(), scopes);
    if (!variable.defined || variable.value === undefined) return match;
    return variable.secret ? '••••••' : variable.value;
  });
  return result === text ? result : previewText(result, scopes, depth + 1);
}

/**
 * Applies the values that scripts left in a scope. Returns `undefined` when nothing changed.
 * Values redacted by the engine are never written back, so secrets cannot be replaced by markers.
 */
export function applyScriptValues(
  rows: readonly VariableRow[],
  values: Record<string, unknown> | undefined,
): VariableRow[] | undefined {
  if (!values) return undefined;
  const next = rows.map((row) => ({ ...row }));
  let changed = false;
  for (const [key, raw] of Object.entries(values)) {
    if (!key || !Object.hasOwn(values, key)) continue;
    const value = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (value.includes(redactedMarker)) continue;
    const existing = next.filter((row) => row.key === key);
    if (!existing.length) {
      next.push(emptyVariable(key, value));
      changed = true;
      continue;
    }
    const active = existing.filter((row) => row.enabled).at(-1) ?? existing.at(-1)!;
    if (active.value !== value || !active.enabled) {
      active.value = value;
      active.enabled = true;
      changed = true;
    }
  }
  for (const row of next)
    if (row.enabled && row.key && !Object.hasOwn(values, row.key)) {
      // A script called `unset`; keep the row but disable it so the user can restore it.
      row.enabled = false;
      changed = true;
    }
  return changed ? next : undefined;
}

/** Converts an engine scope (`{values:[{key,value}]}` or a row list) to a plain map. */
export function scopeValues(value: unknown): Record<string, unknown> | undefined {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray((value as { values?: unknown })?.values)
      ? (value as { values: unknown[] }).values
      : undefined;
  if (!rows) return undefined;
  return Object.fromEntries(
    rows.flatMap((row) =>
      row && typeof row === 'object' && typeof (row as KeyValue).key === 'string'
        ? [[(row as KeyValue).key, (row as KeyValue).value]]
        : [],
    ),
  );
}

/** Collection and folders that contain the item at `path`, root first. */
export function requestAncestors(
  collection: Collection,
  path: readonly number[],
): RequestAncestor[] {
  const ancestors: RequestAncestor[] = [
    {
      name: collection.info?.name ?? 'Collection',
      variable: collection['variable'],
      auth: collection['auth'],
      event: collection['event'],
    },
  ];
  let list: CollectionItem[] | undefined = collection.item;
  for (const index of path.slice(0, -1)) {
    const folder: CollectionItem | undefined = list?.[index];
    if (!folder?.item) break;
    ancestors.push({
      name: folder.name,
      variable: folder['variable'],
      auth: folder['auth'],
      event: folder.event,
    });
    list = folder.item;
  }
  return ancestors;
}

/** Collection variables visible to a request: root first, then its folders. */
export function inheritedCollectionVariables(ancestors: readonly RequestAncestor[]): VariableRow[] {
  return ancestors.flatMap((ancestor) => toVariableRows(ancestor.variable));
}
