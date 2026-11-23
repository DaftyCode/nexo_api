import type { CollectionItem } from './models';

/**
 * A collection shared by the team (C-01), as the backend reports it: its file, whether it is
 * sealed with a team key, the environments shared with it, the elements both people changed
 * that wait for the person, and why it could not keep in step last time.
 */
export interface SharedLink {
  collection: string;
  name: string;
  /** The path of its file, or the URL of its server. */
  path: string;
  kind?: 'folder' | 'url';
  encrypted: boolean;
  environments: string[];
  conflicts: { id: string; name: string }[];
  error?: string | null;
  synced?: number | null;
}

/** How Nexo signs in to the server of a shared collection; the secret goes to the vault. */
export interface SharedCredential {
  scheme: 'none' | 'basic' | 'bearer';
  user?: string;
  secret?: string;
}

/** Where a shared collection's file is: a path in a folder, or the URL of a server. */
export type SharedPlace = { path: string } | { url: string; credential?: SharedCredential };

/** The extension of a shared collection's file: Nexo reads and writes no other. */
export const SHARED_EXTENSION = '.nexo-collection';

/** Whether a path names a shared collection's file. */
export const isSharedFile = (path: string) => path.trim().toLowerCase().endsWith(SHARED_EXTENSION);

const REFUSED = '<>:"/\\|?*';

/** The file a collection is shared as: its name, without what file systems refuse. */
export function sharedFileName(name: string): string {
  const clean = [...name]
    .filter((character) => !REFUSED.includes(character) && character.charCodeAt(0) >= 32)
    .join('')
    .trim();
  return `${clean || 'Collection'}${SHARED_EXTENSION}`;
}

/** A path a person typed, with the extension of a shared file when it has none. */
export function sharedPath(path: string): string {
  const trimmed = path.trim();
  return !trimmed || isSharedFile(trimmed) ? trimmed : `${trimmed}${SHARED_EXTENSION}`;
}

/** The item at `path` of a list of items. */
export function itemAt(
  items: readonly CollectionItem[] | undefined,
  path: readonly number[],
): CollectionItem | undefined {
  let item: CollectionItem | undefined;
  let level = items;
  for (const index of path) {
    item = level?.[index];
    level = item?.item;
  }
  return path.length ? item : undefined;
}

/** Where the item with `id` is in a list of items, depth first. */
export function pathOf(
  items: readonly CollectionItem[] | undefined,
  id: string,
): number[] | undefined {
  for (const [index, item] of (items ?? []).entries()) {
    if (item.id === id) return [index];
    const inner = pathOf(item.item, id);
    if (inner) return [index, ...inner];
  }
  return undefined;
}
