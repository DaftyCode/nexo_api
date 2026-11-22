import { ErdTable } from '../../domain/db/erd';
import {
  DiagramEntity,
  DiagramTable,
  DiagramValue,
  ErdColor,
  diagramTable,
  readDiagram,
} from '../../domain/db/erd-document';
import { named } from '../workspace-state';
import type { DiagramDraft } from './diagram-draft';
import { navigatorSession } from './navigator-session';
import type { DbSection } from './section';

const pathKey = (path: readonly string[]) => path.join('\n');

/** The diagram use cases on the navigator's session of a connection. */
async function reader(section: DbSection, id: string) {
  const at = await navigatorSession(section, id);
  const methods = section.drivers.capabilities(id)?.methods ?? [];
  return { ...at, cases: at.cases.diagrams, structured: methods.includes('ddl.model') };
}

/** The tables of a connection, to put some on a diagram. */
export async function connectionTables(section: DbSection, connection: string) {
  const at = await reader(section, connection);
  return at.cases.tables(at.workspace, at.session, []);
}

/** The columns and foreign keys of some tables of a connection (the query builder's too). */
export async function readTables(section: DbSection, connection: string, tables: DiagramTable[]) {
  const at = await reader(section, connection);
  return at.cases.read(at.workspace, at.session, tables, at.structured);
}

/** Where each table of a saved diagram was, its color, and whether it is hidden. */
function restoreEntities(draft: DiagramDraft, entities: DiagramEntity[], tables: ErdTable[]) {
  const kept = new Map(entities.map((entity) => [pathKey(entity.path), entity]));
  const positions: Record<string, { x: number; y: number }> = {};
  const colors: Record<string, ErdColor> = {};
  const hidden: string[] = [];
  for (const { entity } of tables) {
    const saved = kept.get(pathKey(entity.path));
    if (saved?.x !== undefined && saved.y !== undefined)
      positions[entity.key] = { x: saved.x, y: saved.y };
    if (saved?.color) colors[entity.key] = saved.color;
    if (saved?.hidden) hidden.push(entity.key);
  }
  draft.positions.set(positions);
  draft.colors.set(colors);
  draft.hidden.set(hidden);
}

/** Reads the tables of a diagram, a few at a time, saying how many are read. */
export async function loadDiagram(section: DbSection, draft: DiagramDraft) {
  const source = draft.source;
  const at = await reader(section, source.connection);
  const done = (count: number) =>
    draft.progress.update((progress) => progress && { ...progress, done: count });
  let tables: ErdTable[];
  if (source.kind === 'saved') {
    const document = section.diagrams.saved().find((each) => each.id === source.id);
    const value = readDiagram(document?.value);
    draft.name.set(document?.name ?? '');
    draft.notation.set(value.notation);
    draft.detail.set(value.detail);
    draft.types.set(value.types);
    draft.notes.set(value.notes);
    draft.progress.set({ done: 0, total: value.entities.length });
    tables = await at.cases.read(at.workspace, at.session, value.entities, at.structured, done);
    restoreEntities(draft, value.entities, tables);
  } else if (source.kind === 'table') {
    draft.progress.set({ done: 0, total: 1 });
    const table = diagramTable(source.path);
    tables = await at.cases.related(at.workspace, at.session, table, at.structured, (count) =>
      draft.progress.set({ done: count + 1, total: count + 1 }),
    );
  } else {
    draft.progress.set({ done: 0, total: 0 });
    const found = await at.cases.tables(at.workspace, at.session, source.path);
    draft.progress.set({ done: 0, total: found.length });
    tables = await at.cases.read(at.workspace, at.session, found, at.structured, done);
  }
  draft.tables.set(tables);
  draft.progress.set(undefined);
  draft.loaded.set(true);
}

/** Puts tables on a saved diagram, from `at` down, or shows them again if they were hidden. */
export async function addTables(
  section: DbSection,
  draft: DiagramDraft,
  tables: readonly DiagramTable[],
  at: { x: number; y: number },
) {
  const present = new Map(draft.tables().map(({ entity }) => [pathKey(entity.path), entity.key]));
  const hidden = new Set(draft.hidden());
  const shown = tables.map((table) => present.get(pathKey(table.path))).filter(Boolean);
  if (shown.some((key) => hidden.has(key!)))
    draft.hidden.update((keys) => keys.filter((key) => !shown.includes(key)));
  const fresh = tables.filter((table) => !present.has(pathKey(table.path)));
  if (fresh.length) {
    const reading = await reader(section, draft.source.connection);
    const read = await reading.cases.read(
      reading.workspace,
      reading.session,
      fresh,
      reading.structured,
    );
    draft.tables.update((all) => [...all, ...read]);
    draft.positions.update((positions) => ({
      ...positions,
      ...Object.fromEntries(
        read.map((table, index) => [
          table.entity.key,
          { x: Math.round(at.x + index * 32), y: Math.round(at.y + index * 32) },
        ]),
      ),
    }));
  }
  draft.changed();
}

/** The value of a saved diagram as it is drawn now. */
export function diagramValue(draft: DiagramDraft): DiagramValue {
  const boxes = new Map(draft.scene().entities.map((entity) => [entity.key, entity.box]));
  const hidden = new Set(draft.hidden());
  return {
    connectionId: draft.source.connection,
    notation: draft.notation(),
    detail: draft.detail(),
    types: draft.types(),
    entities: draft.tables().map(({ entity }) => {
      const at = boxes.get(entity.key) ?? draft.positions()[entity.key];
      const color = draft.colors()[entity.key];
      return {
        path: entity.path,
        name: entity.name,
        ...(entity.schema ? { schema: entity.schema } : {}),
        ...(at ? { x: at.x, y: at.y } : {}),
        ...(color ? { color } : {}),
        ...(hidden.has(entity.key) ? { hidden: true } : {}),
      };
    }),
    notes: [...draft.notes()],
  };
}

/** Saves a diagram of the person in its document, as a new revision. */
export async function saveDiagram(section: DbSection, draft: DiagramDraft) {
  const source = draft.source;
  if (source.kind !== 'saved') return undefined;
  const document = section.diagrams.saved().find((each) => each.id === source.id);
  const cases = await section.cases();
  const name = draft.name().trim() || document?.name || 'Diagram';
  await cases.diagrams.save(
    section.state.workspaceId(),
    source.id,
    name,
    diagramValue(draft),
    document,
  );
  draft.name.set(name);
  draft.dirty.set(false);
  await section.state.refresh();
  return named('Diagram saved', name);
}
