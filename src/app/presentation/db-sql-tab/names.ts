import { nodeKey } from '../../domain/db/tree';
import type { DbSection } from '../db-panel/section';

/** Names of the loaded tree of a connection, suggested while typing in its SQL tabs. */
export function treeWords(section: DbSection, connection: string): string[] {
  const prefix = nodeKey(connection, []);
  const names = new Set<string>();
  for (const [key, nodes] of section.tree.children())
    if (key === prefix || key.startsWith(`${prefix}/`))
      for (const node of nodes) if (node.kind !== 'folder') names.add(node.label.split('(')[0]);
  return [...names];
}

/** Databases of the server the tree loaded, to choose one: at its top, or in a folder. */
export function treeDatabases(section: DbSection, connection: string): string[] {
  const children = section.tree.children();
  return [[], ['databases']]
    .flatMap((path) => children.get(nodeKey(connection, path)) ?? [])
    .filter((node) => node.kind === 'database')
    .map((node) => node.label);
}
