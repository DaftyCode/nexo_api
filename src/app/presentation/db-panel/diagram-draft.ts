import { computed, signal } from '@angular/core';
import { ErdDetail, ErdNotation, ErdTable, erdModel } from '../../domain/db/erd';
import { DiagramLayout, DiagramNote, ErdColor } from '../../domain/db/erd-document';
import { ErdLayoutKind, erdLayout } from '../../domain/db/erd-layout';
import { erdScene } from '../../domain/db/erd-scene';
import type { DbTab } from './tabs-store';

/** What a diagram shows: a table and its neighbours, the tables under a node, or saved ones. */
export type DiagramSource =
  | { kind: 'table' | 'node'; connection: string; path: string[] }
  | { kind: 'saved'; connection: string; id: string };

/** The source of a tab's diagram; the tab of an object says whether it is a table or not. */
export function diagramSource(tab: DbTab, table = tab.kind === 'object'): DiagramSource {
  if (tab.kind === 'diagram' && tab.diagram)
    return { kind: 'saved', connection: tab.connection, id: tab.diagram };
  return { kind: table ? 'table' : 'node', connection: tab.connection, path: tab.path ?? [] };
}

interface Place {
  x: number;
  y: number;
}
/** How far the zoom goes, out and in. */
export const ZOOM = { min: 0.1, max: 3 };
/** The selection key of a note: entities are selected by their own key. */
export const noteKey = (id: string) => `note:${id}`;

/**
 * A diagram open in a tab (DB-20), kept by the section while the tab is open: the tables read,
 * how they are drawn, where the person moved them, what is selected, the zoom and the scroll.
 * An automatic diagram keeps its layout in the workspace session as it changes; a saved one is
 * marked as changed until it is saved in its document.
 */
export class DiagramDraft {
  readonly tables = signal<readonly ErdTable[]>([]);
  readonly progress = signal<{ done: number; total: number } | undefined>(undefined);
  readonly loaded = signal(false);
  readonly name = signal('');
  readonly notation = signal<ErdNotation>('idef1x');
  readonly detail = signal<ErdDetail>('all');
  readonly types = signal(true);
  readonly positions = signal<Readonly<Record<string, Place>>>({});
  readonly hidden = signal<readonly string[]>([]);
  readonly colors = signal<Readonly<Record<string, ErdColor>>>({});
  readonly notes = signal<readonly DiagramNote[]>([]);
  readonly selected = signal<ReadonlySet<string>>(new Set());
  /** The relation whose columns are highlighted. */
  readonly relation = signal<string | undefined>(undefined);
  readonly search = signal('');
  readonly zoom = signal(1);
  readonly pan = signal<Place>({ x: 0, y: 0 });
  readonly dirty = signal(false);
  /** Whether its tables were asked for, and whether it was fitted to its canvas once read. */
  started = false;
  framed = false;

  readonly view = computed(() => ({ detail: this.detail(), types: this.types() }));
  /** Every table read, hidden or not: their layout does not move when one is hidden. */
  private readonly full = computed(() => erdModel(this.tables()));
  private readonly auto = computed(() => erdLayout(this.full(), this.view()));
  readonly model = computed(() => {
    const hidden = new Set(this.hidden());
    const { entities, relations } = this.full();
    return {
      entities: entities.filter((entity) => !hidden.has(entity.key)),
      relations: relations.filter((each) => !hidden.has(each.from) && !hidden.has(each.to)),
    };
  });
  readonly scene = computed(() =>
    erdScene({
      model: this.model(),
      view: this.view(),
      notation: this.notation(),
      auto: this.auto(),
      positions: this.positions(),
      colors: this.colors(),
      notes: this.notes(),
    }),
  );
  /** The entities whose name holds the text searched. */
  readonly found = computed(() => {
    const text = this.search().trim().toLowerCase();
    if (!text) return new Set<string>();
    const keys = this.model().entities.map((entity) => entity.key);
    return new Set(keys.filter((key) => key.toLowerCase().includes(text)));
  });
  readonly hiddenEntities = computed(() => {
    const hidden = new Set(this.hidden());
    return this.full().entities.filter((entity) => hidden.has(entity.key));
  });

  /** `keep` saves the layout of an automatic diagram; a saved one has none. */
  constructor(
    readonly source: DiagramSource,
    private readonly keep?: (layout: DiagramLayout) => void,
  ) {}

  /** The layout an automatic diagram keeps in the session, as it is now. */
  layout(): DiagramLayout {
    return {
      positions: { ...this.positions() },
      ...(this.hidden().length ? { hidden: [...this.hidden()] } : {}),
      ...(Object.keys(this.colors()).length ? { colors: { ...this.colors() } } : {}),
      notation: this.notation(),
      detail: this.detail(),
      types: this.types(),
    };
  }
  /** Takes a layout kept, before the tables are read. */
  restore(layout: DiagramLayout | undefined) {
    if (!layout) return;
    this.positions.set(layout.positions);
    this.hidden.set(layout.hidden ?? []);
    this.colors.set(layout.colors ?? {});
    if (layout.notation) this.notation.set(layout.notation);
    if (layout.detail) this.detail.set(layout.detail);
    if (layout.types !== undefined) this.types.set(layout.types);
  }
  /** After a change the person will want to keep. */
  changed() {
    if (this.keep) this.keep(this.layout());
    else this.dirty.set(true);
  }

  setNotation(notation: ErdNotation) {
    this.notation.set(notation);
    this.changed();
  }
  setDetail(detail: ErdDetail) {
    this.detail.set(detail);
    this.changed();
  }
  setTypes(types: boolean) {
    this.types.set(types);
    this.changed();
  }
  /** Lays every entity out again, by layers or in a grid; the places moved are forgotten. */
  arrange(kind: ErdLayoutKind) {
    const boxes = erdLayout(this.full(), this.view(), kind);
    this.positions.set(
      Object.fromEntries(Object.entries(boxes).map(([key, box]) => [key, { x: box.x, y: box.y }])),
    );
    this.changed();
  }

  select(key: string, add = false) {
    const selected = new Set(add ? this.selected() : []);
    if (add && selected.has(key)) selected.delete(key);
    else selected.add(key);
    this.selected.set(selected);
  }
  selectAll() {
    const scene = this.scene();
    this.selected.set(
      new Set([
        ...scene.entities.map((entity) => entity.key),
        ...scene.notes.map((note) => noteKey(note.id)),
      ]),
    );
  }

  /** Moves entities and notes; `changed` is called once the move ends. */
  moveBy(keys: Iterable<string>, dx: number, dy: number) {
    const moving = new Set(keys);
    const boxes = new Map(this.scene().entities.map((entity) => [entity.key, entity.box]));
    const positions = { ...this.positions() };
    for (const key of moving) {
      const box = boxes.get(key);
      if (box) positions[key] = { x: box.x + dx, y: box.y + dy };
    }
    this.positions.set(positions);
    if (this.notes().some((note) => moving.has(noteKey(note.id))))
      this.notes.update((notes) =>
        notes.map((note) =>
          moving.has(noteKey(note.id)) ? { ...note, x: note.x + dx, y: note.y + dy } : note,
        ),
      );
  }

  /** Hides the entities selected and deletes the notes selected. */
  removeSelected() {
    const selected = this.selected();
    const entities = this.model().entities.filter((entity) => selected.has(entity.key));
    const notes = this.notes().filter((note) => selected.has(noteKey(note.id)));
    if (!entities.length && !notes.length) return;
    this.hidden.update((hidden) => [...hidden, ...entities.map((entity) => entity.key)]);
    this.notes.update((all) => all.filter((note) => !notes.includes(note)));
    this.selected.set(new Set());
    this.changed();
  }
  show(key?: string) {
    this.hidden.update((hidden) => (key ? hidden.filter((each) => each !== key) : []));
    this.changed();
  }
  /** Colors the entities selected, or takes their color away. */
  paint(color: ErdColor | undefined) {
    const colors = { ...this.colors() };
    for (const key of this.selected())
      if (this.model().entities.some((entity) => entity.key === key)) {
        if (color) colors[key] = color;
        else delete colors[key];
      }
    this.colors.set(colors);
    this.changed();
  }

  addNote(id: string, at: Place) {
    this.notes.update((notes) => [...notes, { id, text: '', x: at.x, y: at.y }]);
    this.selected.set(new Set([noteKey(id)]));
    this.changed();
  }
  writeNote(id: string, text: string) {
    this.notes.update((notes) => notes.map((note) => (note.id === id ? { ...note, text } : note)));
    this.changed();
  }

  /** Zooms by `factor`, keeping still the point `at` of the canvas. */
  zoomAt(factor: number, at: Place) {
    const zoom = this.zoom();
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, zoom * factor));
    const pan = this.pan();
    this.pan.set({
      x: at.x - ((at.x - pan.x) / zoom) * next,
      y: at.y - ((at.y - pan.y) / zoom) * next,
    });
    this.zoom.set(next);
  }
  /** Fits the whole diagram in a canvas of that size. */
  fit(width: number, height: number) {
    const bounds = this.scene().bounds;
    if (!bounds.width || !bounds.height) return;
    const zoom = Math.min(1, width / bounds.width, height / bounds.height);
    this.zoom.set(Math.max(ZOOM.min, zoom));
    this.pan.set({
      x: (width - bounds.width * this.zoom()) / 2 - bounds.x * this.zoom(),
      y: (height - bounds.height * this.zoom()) / 2 - bounds.y * this.zoom(),
    });
  }
  /** Scrolls so that a point of the diagram is in the middle of a canvas of that size. */
  centerOn(point: Place, width: number, height: number) {
    this.pan.set({
      x: width / 2 - point.x * this.zoom(),
      y: height / 2 - point.y * this.zoom(),
    });
  }
}
