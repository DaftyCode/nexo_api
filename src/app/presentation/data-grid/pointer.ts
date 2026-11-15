import { signal } from '@angular/core';
import { GridColumns } from './columns';

/** Columns resized by the edge of their header, and moved by dragging their header. */
export class GridPointer {
  private resizing?: { column: number; x: number; width: number };
  readonly dragging = signal<number | undefined>(undefined);
  /** Where a dragged column would land: beside which column, and on which side. */
  readonly drop = signal<{ column: number; after: boolean } | undefined>(undefined);

  constructor(
    private readonly columns: GridColumns,
    private readonly widthOf: (column: number) => number,
  ) {}

  resizeStart(event: PointerEvent, column: number) {
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.resizing = { column, x: event.clientX, width: this.widthOf(column) };
  }
  resizeMove(event: PointerEvent) {
    const resizing = this.resizing;
    if (resizing) this.columns.resize(resizing.column, resizing.width + event.clientX - resizing.x);
  }
  resizeEnd() {
    this.resizing = undefined;
  }

  dragStart(event: DragEvent, column: number, name: string) {
    this.dragging.set(column);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', name);
    }
  }
  dragOver(event: DragEvent, column: number) {
    if (this.dragging() === undefined) return;
    event.preventDefault();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    const drop = this.drop();
    if (drop?.column !== column || drop.after !== after) this.drop.set({ column, after });
  }
  dropOn(event: DragEvent, column: number) {
    const dragged = this.dragging();
    const drop = this.drop();
    this.dragEnd();
    if (dragged === undefined || !drop) return;
    event.preventDefault();
    this.columns.move(dragged, column, drop.after);
  }
  dragEnd() {
    this.dragging.set(undefined);
    this.drop.set(undefined);
  }
  /** Where a header shows the drop, for its `data-drop` attribute. */
  at(column: number) {
    const drop = this.drop();
    return drop?.column === column ? (drop.after ? 'after' : 'before') : null;
  }
}
