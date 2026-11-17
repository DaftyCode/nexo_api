import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ErdDetail, ErdNotation } from '../domain/db/erd';
import { DiagramTable, ERD_COLORS, ErdColor, diagramTable } from '../domain/db/erd-document';
import { SceneEntity } from '../domain/db/erd-scene';
import { erdSvg } from '../domain/db/erd-svg';
import { addTables, loadDiagram, saveDiagram } from './db-panel/diagram-load';
import { DbSection } from './db-panel/section';
import { editsStructure } from './db-panel/structure-request';
import type { DbTab } from './db-panel/tabs-store';
import { DbDiagramCanvas } from './db-diagram/canvas';
import { pngOf, svgImage, themePalette } from './db-diagram/export';
import { DbDiagramList } from './db-diagram/list';
import { DbDiagramPicker } from './db-diagram/picker';
import { PanelTask } from './panel-task';
import { StudioIcon } from './studio-icon';

/**
 * An entity-relationship diagram (DB-20), as DBeaver's: a table and the tables one step away
 * in its «Diagram» view, every table under a schema or a database, or a diagram the person
 * builds and saves, dragging tables to it from the navigator. Its toolbar changes the notation
 * and what each entity shows, lays it out again, zooms, searches, colors and hides tables,
 * shows it as a list, and exports it as SVG or PNG or prints it.
 */
@Component({
  imports: [TranslocoPipe, StudioIcon, DbDiagramCanvas, DbDiagramList, DbDiagramPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-diagram',
  host: { '(keydown)': 'shortcut($event)' },
  templateUrl: './db-diagram.html',
  styleUrl: './db-diagram.scss',
})
export class DbDiagram {
  readonly tab = input.required<DbTab>();
  /** In an object's tab: whether the object is a table, or holds tables (a schema). */
  readonly table = input<boolean | undefined>(undefined);
  protected readonly section = inject(DbSection);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly task = new PanelTask(this.section.state);
  protected readonly draft = computed(() => this.section.diagrams.draft(this.tab(), this.table()));
  protected readonly saved = computed(() => this.draft().source.kind === 'saved');
  protected readonly listed = signal(false);
  protected readonly picking = signal(false);
  private readonly canvas = viewChild(DbDiagramCanvas);
  protected readonly notations: [ErdNotation, string][] = [
    ['idef1x', 'IDEF1X'],
    ['crowsfoot', "Crow's foot"],
    ['uml', 'UML'],
  ];
  protected readonly details: [ErdDetail, string][] = [
    ['all', 'All columns'],
    ['keys', 'Keys only'],
    ['none', 'Names only'],
  ];
  protected readonly colors: [ErdColor, string][] = ERD_COLORS.map((color) => [
    color,
    { accent: 'Accent', info: 'Blue', success: 'Green', warning: 'Amber', danger: 'Red' }[color],
  ]);
  protected readonly zoomText = computed(() => `${Math.round(this.draft().zoom() * 100)}%`);
  /** Entities selected, which the color and «Hide» act on. */
  protected readonly chosen = computed(() => {
    const selected = this.draft().selected();
    return this.draft()
      .scene()
      .entities.filter((entity) => selected.has(entity.key)).length;
  });
  /** The one table selected, when its driver edits the structure of tables (DB-19). */
  protected readonly editable = computed(() => {
    const selected = this.draft().selected();
    const shown = this.draft()
      .scene()
      .entities.filter((entity) => selected.has(entity.key));
    const connection = this.draft().source.connection;
    return shown.length === 1 && editsStructure(this.section, connection) ? shown[0] : undefined;
  });
  protected readonly empty = computed(() => {
    const scene = this.draft().scene();
    return !scene.entities.length && !scene.notes.length;
  });
  protected readonly present = computed(() =>
    this.draft()
      .tables()
      .map((table) => table.entity.path),
  );

  constructor() {
    effect(() => {
      const draft = this.draft();
      if (draft.started) return;
      draft.started = true;
      untracked(() => void this.load());
    });
  }

  /** Reads the tables again; a saved diagram with changes keeps them until it is saved. */
  protected load() {
    const draft = this.draft();
    return this.task.run(async () => {
      try {
        await loadDiagram(this.section, draft);
      } finally {
        draft.progress.set(undefined);
      }
    });
  }

  protected title() {
    return (this.saved() && this.draft().name()) || this.tab().title;
  }

  protected setNotation(event: Event) {
    this.draft().setNotation((event.target as HTMLSelectElement).value as ErdNotation);
  }
  protected setDetail(event: Event) {
    this.draft().setDetail((event.target as HTMLSelectElement).value as ErdDetail);
  }
  protected setTypes(event: Event) {
    this.draft().setTypes((event.target as HTMLInputElement).checked);
  }
  protected paint(event: Event) {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    select.value = '';
    if (value) this.draft().paint(value === 'none' ? undefined : (value as ErdColor));
  }
  protected rename(event: Event) {
    this.draft().name.set((event.target as HTMLInputElement).value);
    this.draft().changed();
  }
  protected find(event: Event) {
    this.draft().search.set((event.target as HTMLInputElement).value);
  }
  protected searchKey(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const [first] = this.draft().found();
    if (first) this.canvas()?.reveal(first);
  }

  protected zoom(factor: number) {
    this.canvas()?.zoom(factor);
  }
  protected fit() {
    this.canvas()?.fit();
  }
  protected actualSize() {
    this.draft().zoom.set(1);
  }

  /** Opens the tab of a table of the diagram. */
  protected open(entity: SceneEntity) {
    this.section.tabs.open({
      kind: 'object',
      connection: this.draft().source.connection,
      title: entity.name,
      path: entity.path,
    });
  }

  /** Opens the structure editor on the table selected. */
  protected editStructure(entity: SceneEntity) {
    this.section.structureRequest.set({
      connection: this.draft().source.connection,
      path: entity.path,
      mode: 'edit',
      name: entity.name,
    });
  }

  protected addNote() {
    const id = this.section.state.cases.files.id();
    this.draft().addNote(id, this.canvas()?.center() ?? { x: 0, y: 0 });
    this.canvas()?.write(id);
  }
  protected added(tables: DiagramTable[]) {
    this.picking.set(false);
    const at = this.canvas()?.center() ?? { x: 0, y: 0 };
    void this.task.run(() => addTables(this.section, this.draft(), tables, at));
  }
  /** A table dropped from the navigator: only tables of the diagram's connection. */
  protected dropped(drop: { data: string; at: { x: number; y: number } }) {
    void this.task.run(async () => {
      const table = JSON.parse(drop.data) as { connection?: unknown; path?: unknown };
      if (table.connection !== this.draft().source.connection)
        throw new Error('db.diagram.otherConnection');
      if (!Array.isArray(table.path)) return;
      await addTables(this.section, this.draft(), [diagramTable(table.path.map(String))], drop.at);
    });
  }

  protected save() {
    void this.task.announce('The diagram could not be saved', () =>
      saveDiagram(this.section, this.draft()),
    );
  }
  /** Ctrl+S saves a diagram of the person. */
  protected shortcut(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (this.saved()) this.save();
  }

  private svg() {
    return erdSvg(this.draft().scene(), themePalette(this.host));
  }
  private fileName() {
    return this.title().replace(/[^\w.-]+/g, '-') || 'diagram';
  }
  protected exportSvg() {
    void this.section.state.download(`${this.fileName()}.svg`, this.svg(), 'image/svg+xml');
  }
  protected exportPng() {
    void this.task.run(async () => {
      const { width, height } = this.draft().scene().bounds;
      const png = await pngOf(this.svg(), width, height);
      await this.section.state.download(`${this.fileName()}.png`, png, 'image/png');
    });
  }
  /** Prints the diagram, or saves it as PDF, in the print preview of the reports. */
  protected print() {
    const scene = this.draft().scene();
    const state = this.section.state;
    state.report.set(
      state.reports.diagramReport(this.title(), {
        image: svgImage(this.svg()),
        entities: scene.entities.length,
        relations: scene.lines.length,
      }),
    );
  }
}
