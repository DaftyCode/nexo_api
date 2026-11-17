import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DiagramDraft } from '../db-panel/diagram-draft';

/** The size of the minimap, in pixels. */
const MAP = { width: 160, height: 110 };

/**
 * The whole diagram in small, in a corner of the canvas, with the part shown framed: a click
 * or a drag on it scrolls there. For the mouse only; the list and the keyboard do it too.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-diagram-minimap',
  template: `
    @let place = frame();
    <svg
      class="erd-minimap"
      aria-hidden="true"
      [attr.width]="width"
      [attr.height]="height"
      (pointerdown)="go($event)"
      (pointermove)="drag($event)"
    >
      <g [attr.transform]="place.transform">
        @for (entity of draft().scene().entities; track entity.key) {
          <rect
            class="erd-mini-entity"
            [attr.x]="entity.box.x"
            [attr.y]="entity.box.y"
            [attr.width]="entity.box.width"
            [attr.height]="entity.box.height"
          />
        }
        @let shown = window();
        <rect
          class="erd-mini-window"
          [attr.x]="shown.x"
          [attr.y]="shown.y"
          [attr.width]="shown.width"
          [attr.height]="shown.height"
          [attr.stroke-width]="1 / place.scale"
        />
      </g>
    </svg>
  `,
  styles: `
    :host {
      position: absolute;
      right: var(--nexo-space-6);
      bottom: var(--nexo-space-6);
      border: var(--nexo-border-width) solid var(--nexo-color-border);
      border-radius: var(--nexo-radius-md);
      background: var(--nexo-color-surface);
      box-shadow: var(--nexo-shadow-md);
      overflow: hidden;
    }
    .erd-minimap {
      display: block;
      cursor: pointer;
    }
    .erd-mini-entity {
      fill: var(--nexo-color-surface-3);
      stroke: none;
    }
    .erd-mini-window {
      fill: var(--nexo-color-accent-soft);
      stroke: var(--nexo-color-accent);
    }
  `,
})
export class DbDiagramMinimap {
  readonly draft = input.required<DiagramDraft>();
  /** The size of the canvas, to frame the part of the diagram it shows. */
  readonly size = input.required<{ width: number; height: number }>();
  protected readonly width = MAP.width;
  protected readonly height = MAP.height;
  protected readonly frame = computed(() => {
    const bounds = this.draft().scene().bounds;
    const scale = Math.min(MAP.width / (bounds.width || 1), MAP.height / (bounds.height || 1));
    return {
      bounds,
      scale,
      transform: `scale(${scale}) translate(${-bounds.x} ${-bounds.y})`,
    };
  });
  /** The part of the diagram the canvas shows. */
  protected readonly window = computed(() => {
    const draft = this.draft();
    const { width, height } = this.size();
    const zoom = draft.zoom();
    return {
      x: -draft.pan().x / zoom,
      y: -draft.pan().y / zoom,
      width: width / zoom,
      height: height / zoom,
    };
  });

  protected go(event: PointerEvent) {
    event.stopPropagation();
    const { bounds, scale } = this.frame();
    const box = (event.currentTarget as Element).getBoundingClientRect();
    const { width, height } = this.size();
    this.draft().centerOn(
      {
        x: bounds.x + (event.clientX - box.left) / scale,
        y: bounds.y + (event.clientY - box.top) / scale,
      },
      width,
      height,
    );
  }
  protected drag(event: PointerEvent) {
    if (event.buttons === 1) this.go(event);
  }
}
