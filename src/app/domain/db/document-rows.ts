/**
 * The rows of what the person saved, after the connections in the navigator: SQL scripts under
 * «Scripts», by connection, and entity-relationship diagrams under «Diagrams» (DB-20).
 */
import { readDiagram } from './erd-document';
import type { NavigatorRow, NavigatorSnapshot, SavedDocument } from './rows';
import { readScript } from './sql';
import { matchesText } from './tree';

export const SCRIPTS_KEY = 'scripts';
export const DIAGRAMS_KEY = 'diagrams';

/** The documents whose name holds the text of the filter. */
function shown(snapshot: NavigatorSnapshot, documents: readonly SavedDocument[] = []) {
  const text = snapshot.text.trim();
  return documents.filter((document) => !text || matchesText({ label: document.name }, text));
}

/** The saved scripts, under «Scripts», by connection. */
export function scriptRows(snapshot: NavigatorSnapshot): NavigatorRow[] {
  const text = snapshot.text.trim();
  const scripts = shown(snapshot, snapshot.scripts);
  if (!scripts.length) return [];
  const open = !snapshot.closedFolders.has(SCRIPTS_KEY) || !!text;
  const rows: NavigatorRow[] = [
    {
      key: SCRIPTS_KEY,
      type: 'scripts',
      level: 1,
      label: 'Scripts',
      expandable: true,
      expanded: open,
    },
  ];
  if (!open) return rows;
  const owner = (script: { value: unknown }) => readScript(script.value).connectionId;
  const ids = [...new Set(scripts.map(owner))].sort((a, b) =>
    nameOf(snapshot, a).localeCompare(nameOf(snapshot, b)),
  );
  for (const id of ids) {
    const key = `${SCRIPTS_KEY}:${id}`;
    const expanded = !snapshot.closedFolders.has(key) || !!text;
    rows.push({
      key,
      type: 'script-group',
      level: 2,
      label: nameOf(snapshot, id),
      connection: id,
      parent: SCRIPTS_KEY,
      expandable: true,
      expanded,
    });
    if (!expanded) continue;
    for (const script of scripts
      .filter((item) => owner(item) === id)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const folder = readScript(script.value).folder;
      rows.push({
        key: `script:${script.id}`,
        type: 'script',
        level: 3,
        label: script.name,
        ...(folder ? { detail: folder } : {}),
        connection: id,
        script: script.id,
        parent: key,
        expandable: false,
        expanded: false,
      });
    }
  }
  return rows;
}

/** The saved diagrams, under «Diagrams», by name, each with the name of its connection. */
export function diagramRows(snapshot: NavigatorSnapshot): NavigatorRow[] {
  const diagrams = shown(snapshot, snapshot.diagrams);
  if (!diagrams.length) return [];
  const open = !snapshot.closedFolders.has(DIAGRAMS_KEY) || !!snapshot.text.trim();
  const rows: NavigatorRow[] = [
    {
      key: DIAGRAMS_KEY,
      type: 'diagrams',
      level: 1,
      label: 'Diagrams',
      expandable: true,
      expanded: open,
    },
  ];
  if (!open) return rows;
  for (const diagram of [...diagrams].sort((a, b) => a.name.localeCompare(b.name))) {
    const connection = readDiagram(diagram.value).connectionId;
    rows.push({
      key: `diagram:${diagram.id}`,
      type: 'diagram',
      level: 2,
      label: diagram.name,
      detail: nameOf(snapshot, connection),
      connection,
      diagram: diagram.id,
      parent: DIAGRAMS_KEY,
      expandable: false,
      expanded: false,
    });
  }
  return rows;
}

function nameOf(snapshot: NavigatorSnapshot, id: string) {
  return snapshot.connections.find((connection) => connection.id === id)?.name ?? '—';
}
