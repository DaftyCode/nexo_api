import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { bbox, coordinates, geometryOf, toGeoJson, toWkt } from '../domain/db/geometry';
import { MAX_FIGURES, spatialScene } from '../domain/db/geometry/scene';
import { ResultColumn, cellText, isNull } from '../domain/db/results';
import { WorkspaceState } from './workspace-state';

/** Colors of the values of the column the figures are colored by. */
const COLORS = 8;
/** Rows the list shows, at most. */
const LISTED = 500;

/**
 * The «Spatial» view of a result (DB-29): every geometry of the rows loaded on a canvas with
 * a grid and no background map, zoomed with the wheel or the buttons, moved by dragging and
 * fitted to the data. Choosing a figure chooses its row, in the list beside it too; the other
 * columns of the row go with it, and the figures can take a color per value of a column. The
 * list is also the way to see them without the canvas.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-spatial',
  templateUrl: './db-spatial.html',
  styleUrl: './db-spatial.scss',
})
export class DbSpatial {
  readonly columns = input.required<readonly ResultColumn[]>();
  readonly rows = input.required<readonly (readonly unknown[])[]>();
  /** One value only, in the «Value» panel: no list and no column to choose. */
  readonly compact = input(false);
  readonly name = input('geometries');
  private readonly state = inject(WorkspaceState);
  /** The columns that hold geometries, by their place. */
  protected readonly spatialColumns = computed(() =>
    this.columns().flatMap((_, at) =>
      this.rows()
        .slice(0, 50)
        .some((row) => !!geometryOf(row[at]))
        ? [at]
        : [],
    ),
  );
  protected readonly chosen = signal<number | undefined>(undefined);
  protected readonly column = computed(() => this.chosen() ?? this.spatialColumns()[0] ?? -1);
  protected readonly colorBy = signal(-1);
  protected readonly selected = signal<number | undefined>(undefined);
  protected readonly hovered = signal<number | undefined>(undefined);
  protected readonly listed = signal(false);
  protected readonly geometries = computed(() =>
    this.rows().map((row) => (this.column() >= 0 ? geometryOf(row[this.column()]) : undefined)),
  );
  protected readonly scene = computed(() => spatialScene(this.geometries()));
  protected readonly maxFigures = MAX_FIGURES;
  /** What is in view: the data fitted, or where the person zoomed and moved. */
  protected readonly zoom = signal<
    { x: number; y: number; width: number; height: number } | undefined
  >(undefined);
  protected readonly view = computed(() => {
    const zoomed = this.zoom();
    if (zoomed) return zoomed;
    const view = this.scene().view;
    if (!view) return { x: 0, y: 0, width: 1, height: 1 };
    const pad = Math.max(view.width, view.height) * 0.05 || 1;
    return {
      x: view.x - pad,
      y: view.y - pad,
      width: view.width + 2 * pad,
      height: view.height + 2 * pad,
    };
  });
  protected readonly viewBox = computed(() => {
    const view = this.view();
    return `${view.x} ${view.y} ${view.width} ${view.height}`;
  });
  /** The radius of a point, the same on screen whatever the zoom. */
  protected readonly radius = computed(() => Math.max(this.view().width, this.view().height) / 120);
  /** A color per value of the column chosen, by first appearance. */
  private readonly colorOf = computed(() => {
    const by = this.colorBy();
    const values = new Map<string, number>();
    if (by >= 0)
      for (const row of this.rows()) {
        const key = cellText(row[by]);
        if (!values.has(key)) values.set(key, values.size % COLORS);
      }
    return values;
  });
  protected readonly list = computed(() =>
    this.geometries()
      .flatMap((spatial, row) => {
        if (!spatial) return [];
        const points = coordinates(spatial.geometry);
        const box = bbox(points);
        return [{ row, type: spatial.geometry.type, points: points.length, box }];
      })
      .slice(0, LISTED),
  );

  protected figureClass(row: number) {
    const color =
      this.colorBy() >= 0
        ? this.colorOf().get(cellText(this.rows()[row]?.[this.colorBy()]))
        : undefined;
    return color === undefined ? 'sp-color-none' : `sp-color-${color}`;
  }
  /** The other cells of a row, as the pointer shows them. */
  protected details(row: number) {
    const values = this.rows()[row] ?? [];
    return this.columns()
      .map((column, at) => ({ name: column.name, at }))
      .filter((each) => each.at !== this.column())
      .slice(0, 8)
      .map(
        (each) =>
          `${each.name}: ${isNull(values[each.at]) ? 'NULL' : cellText(values[each.at]).slice(0, 60)}`,
      )
      .join(' · ');
  }
  protected box(box: [number, number, number, number] | undefined) {
    if (!box) return '—';
    const n = (value: number) => String(Math.round(value * 1e6) / 1e6);
    return `${n(box[0])}, ${n(box[1])} → ${n(box[2])}, ${n(box[3])}`;
  }

  protected scale(factor: number) {
    const view = this.view();
    const width = view.width * factor;
    const height = view.height * factor;
    this.zoom.set({
      x: view.x + (view.width - width) / 2,
      y: view.y + (view.height - height) / 2,
      width,
      height,
    });
  }
  protected wheel(event: WheelEvent) {
    event.preventDefault();
    this.scale(event.deltaY > 0 ? 1.25 : 0.8);
  }
  private drag?: {
    x: number;
    y: number;
    view: { x: number; y: number; width: number; height: number };
  };
  protected down(event: PointerEvent) {
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    this.drag = { x: event.clientX, y: event.clientY, view: this.view() };
  }
  protected move(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    const box = (event.currentTarget as Element).getBoundingClientRect();
    if (!box.width) return;
    const per = drag.view.width / box.width;
    this.zoom.set({
      ...drag.view,
      x: drag.view.x - (event.clientX - drag.x) * per,
      y: drag.view.y - (event.clientY - drag.y) * per,
    });
  }
  protected up() {
    this.drag = undefined;
  }

  /** The geometry of the row chosen, as WKT or GeoJSON, to the clipboard. */
  protected copy(as: 'wkt' | 'geojson') {
    const spatial = this.geometries()[this.selected() ?? -1];
    if (!spatial) return;
    const text =
      as === 'wkt' ? toWkt(spatial.geometry) : JSON.stringify(toGeoJson(spatial.geometry));
    void globalThis.navigator?.clipboard?.writeText(text);
  }
  /** Every row as a GeoJSON feature, its other columns as properties. */
  protected exportGeoJson() {
    const names = this.columns().map((column) => column.name);
    const features = this.rows().map((row, at) => {
      const spatial = this.geometries()[at];
      const properties = Object.fromEntries(
        names.flatMap((name, index) =>
          index === this.column() ? [] : [[name, isNull(row[index]) ? null : cellText(row[index])]],
        ),
      );
      return {
        type: 'Feature',
        geometry: spatial ? toGeoJson(spatial.geometry) : null,
        properties,
      };
    });
    const text = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    void this.state.download(`${this.name()}.geojson`, text, 'application/geo+json');
  }
}
