import { WorkspaceDocument } from './models';
import { exportableCollection, masked } from './sanitize';

/** A collection of a workspace Git project, as `export` wrote it. */
export interface RepositoryFile {
  id: string;
  value: unknown;
}

/** A remote of a workspace Git project. */
export interface GitRemote {
  name: string;
  url: string;
}

/** What a pull or a clone changes in the workspace. */
export interface RepositoryImport {
  /** New and changed collections, ready to save. */
  save: WorkspaceDocument[];
  added: number;
  updated: number;
  unchanged: number;
  /** Files whose identifier belongs to a document that is not a collection. */
  skipped: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** JSON with sorted keys, to compare documents whatever the order of their fields. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * The repository version of a collection with what the export left out taken from the local
 * one: credentials it masked and the local transport settings. Rows are matched by `key`
 * when they have one, else by position.
 */
export function restoreLocalValues(repository: unknown, local: unknown): unknown {
  if (repository === masked) return typeof local === 'string' ? local : repository;
  if (Array.isArray(repository)) {
    const rows = Array.isArray(local) ? local : [];
    const keyOf = (row: unknown) => (isObject(row) ? row['key'] : undefined);
    return repository.map((item, index) => {
      const key = keyOf(item);
      const match = typeof key === 'string' ? rows.find((row) => keyOf(row) === key) : rows[index];
      return restoreLocalValues(item, match);
    });
  }
  if (!isObject(repository)) return repository;
  const before = isObject(local) ? local : {};
  const restored: Record<string, unknown> = Object.fromEntries(
    Object.entries(repository).map(([key, item]) => [key, restoreLocalValues(item, before[key])]),
  );
  if ('nexoTransport' in before && !('nexoTransport' in repository))
    restored['nexoTransport'] = before['nexoTransport'];
  return restored;
}

function collectionName(value: unknown, fallback: string) {
  const info = isObject(value) ? value['info'] : undefined;
  const name = isObject(info) ? info['name'] : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : fallback;
}

/**
 * Adds the repository's new collections and updates those with the same identifier. Those
 * only in the workspace stay, and a collection whose export did not change is left alone.
 */
export function repositoryImport(
  files: readonly RepositoryFile[],
  documents: readonly WorkspaceDocument[],
  workspace: string,
): RepositoryImport {
  const plan: RepositoryImport = { save: [], added: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const file of files) {
    if (!isObject(file.value)) {
      plan.skipped++;
      continue;
    }
    const existing = documents.find((document) => document.id === file.id);
    if (existing && existing.kind !== 'collection') {
      plan.skipped++;
      continue;
    }
    const name = collectionName(file.value, file.id);
    if (!existing) {
      plan.added++;
      plan.save.push({
        id: file.id,
        workspace_id: workspace,
        kind: 'collection',
        name,
        revision: 0,
        updated_at: 0,
        value: file.value,
      });
    } else if (stableJson(exportableCollection(existing.value)) === stableJson(file.value)) {
      plan.unchanged++;
    } else {
      plan.updated++;
      plan.save.push({
        ...existing,
        name,
        value: restoreLocalValues(file.value, existing.value),
      });
    }
  }
  return plan;
}

/** A workspace name for a clone: the repository's name in its URL. */
export function repositoryName(url: string) {
  const last =
    url
      .trim()
      .replace(/[/\\]+$/, '')
      .split(/[/:\\]/)
      .at(-1) ?? '';
  return last.replace(/\.git$/i, '') || 'Cloned repository';
}
