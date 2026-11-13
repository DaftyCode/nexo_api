import { signal } from '@angular/core';

/** Which side of an element a dragged one lands on. */
export type DropSide = 'before' | 'after';

/**
 * Dragging the elements of a flat list (request tabs, the sections of the side menu,
 * collections) to put them in another order. Only elements of the same list are accepted.
 */
export class ListDrag {
  /** The element being dragged. */
  readonly dragging = signal<string | undefined>(undefined);
  /** Where it would land, to draw it, and whether the list runs in a row (`x`) or a column. */
  readonly hint = signal<{ id: string; side: DropSide; axis: 'x' | 'y' } | undefined>(undefined);

  /**
   * @param axis `x` for lists laid out in a row, such as tabs; `y` for columns; `auto` for lists
   *   whose layout changes with the template, read from where the neighbours are.
   * @param move Moves `id` before or after `over`.
   */
  constructor(
    private readonly axis: 'x' | 'y' | 'auto',
    private readonly move: (id: string, over: string, side: DropSide) => void,
  ) {}

  start(event: DragEvent, id: string, label: string) {
    this.dragging.set(id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox only starts a drag with some data.
      event.dataTransfer.setData('text/plain', label);
    }
  }
  private place(event: DragEvent): { side: DropSide; axis: 'x' | 'y' } {
    const element = event.currentTarget as HTMLElement;
    const box = element.getBoundingClientRect();
    const axis = this.axis === 'auto' ? rowAxis(element, box) : this.axis;
    const ratio =
      axis === 'x'
        ? (event.clientX - box.left) / Math.max(box.width, 1)
        : (event.clientY - box.top) / Math.max(box.height, 1);
    return { side: ratio < 0.5 ? 'before' : 'after', axis };
  }
  /** Accepts the drop when an element of this list is dragged; returns whether it did. */
  over(event: DragEvent, id: string) {
    if (!this.dragging()) return false;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const { side, axis } = this.place(event);
    const hint = this.hint();
    if (hint?.id !== id || hint.side !== side || hint.axis !== axis)
      this.hint.set({ id, side, axis });
    return true;
  }
  /**
   * Where an element shows the drop, if the dragged one would land next to it: `before-y`,
   * `after-x`… for the `data-drop` attribute the styles draw.
   */
  at(id: string) {
    const hint = this.hint();
    return hint?.id === id ? `${hint.side}-${hint.axis}` : undefined;
  }
  /** Moves the dragged element; returns whether one of this list was dropped. */
  drop(event: DragEvent, id: string) {
    const dragged = this.dragging();
    if (!dragged) return false;
    event.preventDefault();
    const { side } = this.place(event);
    this.end();
    if (dragged !== id) this.move(dragged, id, side);
    return true;
  }
  end() {
    this.dragging.set(undefined);
    this.hint.set(undefined);
  }
}

/** `x` when a neighbour of the element sits beside it, as in a row or a grid. */
function rowAxis(element: HTMLElement, box: DOMRect): 'x' | 'y' {
  const beside = [element.previousElementSibling, element.nextElementSibling].some(
    (other) => !!other && Math.abs(other.getBoundingClientRect().top - box.top) < box.height / 2,
  );
  return beside ? 'x' : 'y';
}

/** The position in a list of ids where an element dropped before or after `over` goes. */
export function dropIndex(ids: readonly string[], over: string, side: DropSide) {
  const index = ids.indexOf(over);
  return side === 'before' ? index : index + 1;
}
