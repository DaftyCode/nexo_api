import { computed, signal, untracked } from '@angular/core';
import { DiagramLayout, emptyDiagram, layoutKey, readDiagram } from '../../domain/db/erd-document';
import { NavigatorRow } from '../../domain/db/rows';
import { WorkspaceDocument } from '../../domain/models';
import { named } from '../workspace-state';
import { DiagramDraft, diagramSource } from './diagram-draft';
import type { DbSection } from './section';
import type { DbTab } from './tabs-store';

/** What a table of the navigator carries when it is dragged to a diagram. */
export const TABLE_DRAG = 'application/x-nexo-table';

/**
 * The diagrams of the section (DB-20): where the entities of each automatic diagram were moved,
 * kept in the workspace session, and the diagrams the person saved (`db-diagram` documents),
 * opened in tabs of their own.
 */
export class SectionDiagrams {
  readonly layouts = signal<Readonly<Record<string, DiagramLayout>>>({});
  readonly saved = computed(() =>
    this.section.state.documents().filter((document) => document.kind === 'db-diagram'),
  );

  /** The diagram of each open tab, kept while it is open: a tab draws only when active. */
  private readonly drafts = new Map<string, DiagramDraft>();

  constructor(private readonly section: DbSection) {
    const stored = untracked(() => section.state.databaseSession())?.diagrams;
    if (stored) this.layouts.set(stored);
  }

  layout(connection: string, path: readonly string[]): DiagramLayout | undefined {
    return this.layouts()[layoutKey(connection, path)];
  }
  keep(connection: string, path: readonly string[], layout: DiagramLayout) {
    this.layouts.update((all) => ({ ...all, [layoutKey(connection, path)]: layout }));
  }

  /** The diagram of a tab: a diagram tab, or the «Diagram» of an object's tab. */
  draft(tab: DbTab, table?: boolean): DiagramDraft {
    const open = new Set(this.section.tabs.tabs().map((each) => each.id));
    for (const id of [...this.drafts.keys()]) if (!open.has(id)) this.drafts.delete(id);
    const kept = this.drafts.get(tab.id);
    if (kept) return kept;
    // Asked for from a view's `computed`: restoring the layout kept writes the draft's
    // signals, which a `computed` may not, so the draft is made outside it.
    return untracked(() => {
      const source = diagramSource(tab, table);
      const draft =
        source.kind === 'saved'
          ? new DiagramDraft(source)
          : new DiagramDraft(source, (layout) => this.keep(source.connection, source.path, layout));
      if (source.kind !== 'saved') draft.restore(this.layout(source.connection, source.path));
      this.drafts.set(tab.id, draft);
      return draft;
    });
  }
  /** Whether a tab holds a saved diagram with changes not saved yet. */
  unsaved(tab: string) {
    return !!this.drafts.get(tab)?.dirty();
  }

  /**
   * The diagram of a row: of an object that opens (a table, a schema, a database), the
   * «Diagram» of its tab; of a folder of tables, a tab with all of them.
   */
  view(row: NavigatorRow) {
    if (!row.connection || !row.path) return;
    const tab = { connection: row.connection, title: row.label, path: row.path };
    if (!row.node?.actions.includes('open'))
      return void this.section.tabs.open({ kind: 'diagram', ...tab });
    const opened = this.section.tabs.open({ kind: 'object', ...tab });
    this.section.tabs.update(opened.id, { part: 'diagram' });
  }

  /** A new diagram of a connection, empty, to drag its tables to. */
  async create(connection: string) {
    const cases = await this.section.cases();
    const document = await cases.diagrams.save(
      this.section.state.workspaceId(),
      this.section.state.cases.files.id(),
      'Diagram',
      emptyDiagram(connection),
    );
    await this.section.state.refresh();
    this.open(document);
    return undefined;
  }

  open(document: WorkspaceDocument) {
    this.section.tabs.open({
      kind: 'diagram',
      connection: readDiagram(document.value).connectionId,
      title: document.name,
      diagram: document.id,
    });
  }
  openId(id: string) {
    const document = this.saved().find((each) => each.id === id);
    if (document) this.open(document);
  }

  async remove(id: string) {
    const document = this.saved().find((each) => each.id === id);
    if (!document || !this.section.state.confirm('Delete this diagram?')) return undefined;
    const cases = await this.section.cases();
    await cases.diagrams.remove(document);
    for (const tab of this.section.tabs.tabs())
      if (tab.diagram === document.id) this.section.tabs.close(tab.id);
    await this.section.state.refresh();
    return named('Diagram deleted', document.name);
  }
}
