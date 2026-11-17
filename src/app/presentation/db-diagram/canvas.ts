import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { SceneEntity, SceneNote } from '../../domain/db/erd-scene';
import { DiagramDraft, noteKey } from '../db-panel/diagram-draft';
import { TABLE_DRAG } from '../db-panel/diagrams';
import { DbDiagramMinimap } from './minimap';

interface Place {
  x: number;
  y: number;
}
/** How far an arrow moves an entity, and with Shift. */
const STEP = { small: 10, large: 50 };
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The canvas of a diagram: the scene drawn in SVG, zoomed with the wheel and scrolled by
 * dragging its background. An entity is selected with a click (Ctrl or Shift add to the
 * selection) and dragged with the others selected; with the keyboard, the arrows move it,
 * Enter opens its table and Delete hides it. A relation clicked lights up its columns.
 */
@Component({
  imports: [TranslocoPipe, DbDiagramMinimap],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-diagram-canvas',
  templateUrl: './canvas.html',
  styleUrl: './canvas.scss',
})
export class DbDiagramCanvas {
  readonly draft = input.required<DiagramDraft>();
  /** A saved diagram: tables are dropped on it and its notes are written. */
  readonly editable = input(false);
  readonly opened = output<SceneEntity>();
  readonly dropped = output<{ data: string; at: Place }>();
  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  private readonly injector = inject(Injector);
  readonly size = signal({ width: 800, height: 600 });
  private readonly measured = signal(false);
  /** The note being written. */
  protected readonly editing = signal<string | undefined>(undefined);
  private gesture?: { kind: 'move' | 'pan'; x: number; y: number; moved: boolean; pan: Place };
  protected readonly noteKey = noteKey;

  protected readonly transform = computed(() => {
    const pan = this.draft().pan();
    return `translate(${pan.x} ${pan.y}) scale(${this.draft().zoom()})`;
  });
  /** The columns of the relation clicked, as `entity\ncolumn`. */
  protected readonly lit = computed(() => {
    const draft = this.draft();
    const line = draft.scene().lines.find((each) => each.key === draft.relation());
    if (!line) return new Set<string>();
    return new Set([
      ...line.fromColumns.map((column) => `${line.from}\n${column}`),
      ...line.toColumns.map((column) => `${line.to}\n${column}`),
    ]);
  });
  protected readonly note = computed(() =>
    this.draft()
      .scene()
      .notes.find((note) => note.id === this.editing()),
  );

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const element = this.viewport().nativeElement;
      const measure = () =>
        this.size.set({
          width: element.clientWidth || 800,
          height: element.clientHeight || 600,
        });
      measure();
      this.measured.set(true);
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      destroy.onDestroy(() => observer.disconnect());
    });
    // A diagram read is fitted to its canvas once; after that, it stays as it was left.
    effect(() => {
      const draft = this.draft();
      if (!this.measured() || !draft.loaded() || draft.framed) return;
      draft.framed = true;
      untracked(() => this.fit());
    });
  }

  fit() {
    const { width, height } = this.size();
    this.draft().fit(width, height);
  }
  /** The point of the diagram in the middle of the canvas. */
  center(): Place {
    const { width, height } = this.size();
    const draft = this.draft();
    return {
      x: (width / 2 - draft.pan().x) / draft.zoom(),
      y: (height / 2 - draft.pan().y) / draft.zoom(),
    };
  }
  zoom(factor: number) {
    const { width, height } = this.size();
    this.draft().zoomAt(factor, { x: width / 2, y: height / 2 });
  }
  /** Scrolls to an entity, selects it and moves the focus to it. */
  reveal(key: string) {
    const draft = this.draft();
    const entity = draft.scene().entities.find((each) => each.key === key);
    if (!entity) return;
    const { width, height } = this.size();
    const { box } = entity;
    draft.centerOn({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, width, height);
    draft.select(key);
    this.focus(key);
  }
  /** Starts writing a note. */
  write(id: string) {
    this.editing.set(id);
    afterNextRender(
      () => this.viewport().nativeElement.querySelector<HTMLElement>('.erd-note-editor')?.focus(),
      { injector: this.injector },
    );
  }

  private focus(key: string) {
    afterNextRender(
      () =>
        this.viewport()
          .nativeElement.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
          ?.focus(),
      { injector: this.injector },
    );
  }
  private point(event: { clientX: number; clientY: number }): Place {
    const box = this.viewport().nativeElement.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  protected wheel(event: WheelEvent) {
    event.preventDefault();
    this.draft().zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, this.point(event));
  }

  /** A press on an entity or a note (`key`) or on the background. */
  protected down(event: PointerEvent, key?: string) {
    if (event.button !== 0) return;
    const draft = this.draft();
    const add = event.ctrlKey || event.metaKey || event.shiftKey;
    event.stopPropagation();
    if (key && add) return draft.select(key, true);
    if (key && !draft.selected().has(key)) draft.select(key);
    if (!key && !add) {
      draft.selected.set(new Set());
      draft.relation.set(undefined);
    }
    const kind = key ? 'move' : 'pan';
    this.gesture = { kind, x: event.clientX, y: event.clientY, moved: false, pan: draft.pan() };
    this.viewport().nativeElement.setPointerCapture?.(event.pointerId);
  }
  protected move(event: PointerEvent) {
    const gesture = this.gesture;
    if (!gesture) return;
    const draft = this.draft();
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!dx && !dy) return;
    gesture.moved = true;
    if (gesture.kind === 'pan')
      return draft.pan.set({ x: gesture.pan.x + dx, y: gesture.pan.y + dy });
    draft.moveBy(draft.selected(), dx / draft.zoom(), dy / draft.zoom());
    gesture.x = event.clientX;
    gesture.y = event.clientY;
  }
  protected up() {
    if (this.gesture?.kind === 'move' && this.gesture.moved) this.draft().changed();
    this.gesture = undefined;
  }

  /** The keys of an entity or a note. */
  protected key(event: KeyboardEvent, key: string, entity?: SceneEntity) {
    const draft = this.draft();
    const arrow = ARROWS[event.key];
    if (arrow) {
      event.preventDefault();
      const step = event.shiftKey ? STEP.large : STEP.small;
      const keys = draft.selected().has(key) ? draft.selected() : [key];
      draft.moveBy(keys, arrow[0] * step, arrow[1] * step);
      draft.changed();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (entity) this.opened.emit(entity);
      else if (this.editable()) this.write(key.slice('note:'.length));
    } else if (event.key === ' ') {
      event.preventDefault();
      draft.select(key, event.ctrlKey || event.metaKey || event.shiftKey);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      if (!draft.selected().has(key)) draft.select(key);
      draft.removeSelected();
    }
  }
  /** The keys of the canvas: Ctrl+A selects everything, Escape nothing, + and - zoom. */
  protected canvasKey(event: KeyboardEvent) {
    const draft = this.draft();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      draft.selectAll();
    } else if (event.key === 'Escape') {
      draft.selected.set(new Set());
      draft.relation.set(undefined);
    } else if (event.key === '+' || event.key === '-') {
      event.preventDefault();
      this.zoom(event.key === '+' ? 1.2 : 1 / 1.2);
    }
  }

  protected lines(note: SceneNote) {
    return note.text ? note.text.split('\n') : [];
  }
  protected written(id: string, event: Event) {
    this.draft().writeNote(id, (event.target as HTMLTextAreaElement).value);
  }
  protected writeKey(event: KeyboardEvent, id: string) {
    event.stopPropagation();
    if (event.key !== 'Escape' && !(event.key === 'Enter' && (event.ctrlKey || event.metaKey)))
      return;
    event.preventDefault();
    this.editing.set(undefined);
    this.focus(noteKey(id));
  }

  protected dragOver(event: DragEvent) {
    if (!this.editable() || !event.dataTransfer?.types.includes(TABLE_DRAG)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
  protected drop(event: DragEvent) {
    const data = event.dataTransfer?.getData(TABLE_DRAG);
    if (!this.editable() || !data) return;
    event.preventDefault();
    const draft = this.draft();
    const at = this.point(event);
    this.dropped.emit({
      data,
      at: { x: (at.x - draft.pan().x) / draft.zoom(), y: (at.y - draft.pan().y) / draft.zoom() },
    });
  }
}
