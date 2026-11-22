/**
 * What the spatial viewer draws (DB-29): each geometry of the rows loaded as an SVG path in
 * the coordinates of its system, north up. WGS 84 (SRID 4326) is drawn in Web Mercator, as
 * maps are; Web Mercator (3857) as it is; any other system in its own units, said as such.
 * There is no background map: nothing is asked of a server outside Nexo.
 */
import { Coord, Geometry, Spatial, bbox, coordinates } from '../geometry';

export type SpatialUnits = 'geographic' | 'mercator' | 'own';

export interface SpatialFigure {
  /** The row of the result it is. */
  row: number;
  /** Areas and lines as a path; points as a circle at `point`. */
  d: string;
  point?: Coord;
  /** What it is drawn as: an area (filled), a line, or a point. */
  shape: 'area' | 'line' | 'point';
}

export interface SpatialScene {
  figures: SpatialFigure[];
  /** The box of everything drawn, in drawing units; none with nothing to draw. */
  view?: { x: number; y: number; width: number; height: number };
  units: SpatialUnits;
  /** The systems the rows use, when they are more than one (drawn together anyway). */
  srids: number[];
}

/** Figures drawn at most: past them the list says how many there are. */
export const MAX_FIGURES = 5_000;
const EARTH = 6_378_137;

/** A coordinate in the drawing units of its system, y downwards. */
export function project([x, y]: Coord, units: SpatialUnits): Coord {
  if (units !== 'geographic') return [x, -y];
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, y));
  const mercator = EARTH * Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
  return [(x * Math.PI * EARTH) / 180, -mercator];
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const line = (points: readonly Coord[], units: SpatialUnits) =>
  points
    .map((point, at) => {
      const [x, y] = project(point, units);
      return `${at ? 'L' : 'M'} ${round(x)} ${round(y)}`;
    })
    .join(' ');

/** The figures of one geometry: a collection gives one per part. */
function figures(geometry: Geometry, row: number, units: SpatialUnits): SpatialFigure[] {
  switch (geometry.type) {
    case 'Point':
      return geometry.coordinates
        ? [{ row, d: '', point: project(geometry.coordinates, units), shape: 'point' }]
        : [];
    case 'MultiPoint':
      return geometry.coordinates.map((point) => ({
        row,
        d: '',
        point: project(point, units),
        shape: 'point',
      }));
    case 'LineString':
      return geometry.coordinates.length
        ? [{ row, d: line(geometry.coordinates, units), shape: 'line' }]
        : [];
    case 'MultiLineString':
      return [
        { row, d: geometry.coordinates.map((each) => line(each, units)).join(' '), shape: 'line' },
      ];
    case 'Polygon':
      return [
        {
          row,
          d: geometry.coordinates.map((ring) => `${line(ring, units)} Z`).join(' '),
          shape: 'area',
        },
      ];
    case 'MultiPolygon':
      return [
        {
          row,
          d: geometry.coordinates
            .flatMap((polygon) => polygon.map((ring) => `${line(ring, units)} Z`))
            .join(' '),
          shape: 'area',
        },
      ];
    case 'GeometryCollection':
      return geometry.geometries.flatMap((part) => figures(part, row, units));
  }
}

/** The scene of the geometries of some rows, by row; rows without one are left out. */
export function spatialScene(rows: readonly (Spatial | undefined)[]): SpatialScene {
  const srids = [...new Set(rows.flatMap((each) => (each?.srid ? [each.srid] : [])))];
  const srid = srids[0];
  const units: SpatialUnits = srid === 4326 ? 'geographic' : srid === 3857 ? 'mercator' : 'own';
  const drawn: SpatialFigure[] = [];
  const all: Coord[] = [];
  rows.forEach((each, row) => {
    if (!each || drawn.length >= MAX_FIGURES) return;
    drawn.push(...figures(each.geometry, row, units));
    all.push(...coordinates(each.geometry).map((point) => project(point, units)));
  });
  const box = bbox(all);
  const view = box && {
    x: box[0],
    y: box[1],
    width: Math.max(box[2] - box[0], 1e-9),
    height: Math.max(box[3] - box[1], 1e-9),
  };
  return {
    figures: drawn.slice(0, MAX_FIGURES),
    ...(view ? { view } : {}),
    units,
    srids: srids.length > 1 ? srids : [],
  };
}
