import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

/**
 * A divider dragged with the mouse (or moved with the arrow keys) to resize the panel next to
 * it, like the dividers of Windows or Postman. Panels are found by selector inside the
 * workspace, so templates can lay them out differently.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-splitter',
  template: '',
  host: {
    class: 'splitter',
    role: 'separator',
    tabindex: '0',
    '[class.vertical]': "axis() === 'x'",
    '[class.horizontal]': "axis() === 'y'",
    '[class.dragging]': 'dragging()',
    '[attr.aria-orientation]': "axis() === 'x' ? 'vertical' : 'horizontal'",
    '[attr.aria-label]': 'label()',
    '[attr.title]': 'label()',
    '(pointerdown)': 'start($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'end()',
    '(pointercancel)': 'end()',
    '(lostpointercapture)': 'end()',
    '[attr.aria-valuenow]': 'now()',
    '(dblclick)': 'restore.emit()',
    '(keydown)': 'key($event)',
  },
})
export class Splitter {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  /** `x` resizes a width (a vertical divider), `y` a height. */
  readonly axis = input<'x' | 'y'>('x');
  /** Selector of the panel resized. */
  readonly target = input.required<string>();
  /** Selector of the panel that gives or takes the space, kept at `neighborMin`. */
  readonly neighbor = input('');
  readonly neighborMin = input(160);
  /** The panel lies after the divider: dragging towards it makes it smaller. */
  readonly invert = input(false);
  readonly label = input('Resize');
  /** New size of the panel, in pixels, while it is dragged. */
  readonly resized = output<number>();
  /** The drag ended: the size can be kept. */
  readonly settled = output<void>();
  /** Double-click: back to the template size. */
  readonly restore = output<void>();
  protected readonly dragging = signal(false);
  /** Size of the panel, announced to assistive technologies. */
  protected readonly now = signal(0);
  private origin?: { pointer: number; size: number; max: number };

  constructor() {
    afterNextRender(() => this.now.set(Math.round(this.bounds()?.size ?? 0)));
  }

  protected start(event: PointerEvent) {
    if (event.button !== 0) return;
    const bounds = this.bounds();
    if (!bounds) return;
    event.preventDefault();
    this.host.setPointerCapture?.(event.pointerId);
    this.origin = { pointer: this.position(event), ...bounds };
    this.dragging.set(true);
  }
  protected move(event: PointerEvent) {
    if (!this.origin) return;
    const moved = this.position(event) - this.origin.pointer;
    this.emit(this.origin.size + (this.invert() ? -moved : moved), this.origin.max);
  }
  protected end() {
    if (!this.origin) return;
    this.origin = undefined;
    this.dragging.set(false);
    this.settled.emit();
  }
  protected key(event: KeyboardEvent) {
    const keys = this.axis() === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const direction = keys.indexOf(event.key);
    if (direction < 0) return;
    const bounds = this.bounds();
    if (!bounds) return;
    event.preventDefault();
    const step = (direction ? 1 : -1) * (event.shiftKey ? 64 : 16) * (this.invert() ? -1 : 1);
    this.emit(bounds.size + step, bounds.max);
    this.settled.emit();
  }
  private emit(size: number, max: number) {
    const next = Math.round(Math.min(size, max));
    this.now.set(next);
    this.resized.emit(next);
  }
  private position(event: PointerEvent) {
    return this.axis() === 'x' ? event.clientX : event.clientY;
  }
  /** Current size of the panel and how far it may grow without squeezing its neighbor. */
  private bounds() {
    const scope = this.host.closest('.studio') ?? this.host.ownerDocument;
    const target = scope.querySelector(this.target());
    if (!target) return undefined;
    const measure = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return this.axis() === 'x' ? rect.width : rect.height;
    };
    const size = measure(target);
    const neighbor = this.neighbor() ? scope.querySelector(this.neighbor()) : null;
    const max = neighbor
      ? size + Math.max(0, measure(neighbor) - this.neighborMin())
      : Number.POSITIVE_INFINITY;
    return { size, max };
  }
}
