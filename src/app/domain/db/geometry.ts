/**
 * Spatial values (DB-29): the geometries the drivers send as EWKB in hexadecimal (PostGIS,
 * MySQL and SQL Server, each one turned to it by its driver) or as WKT, read into GeoJSON-like
 * shapes: points, lines, polygons, their multi forms and collections, with their SRID. Z and M
 * are read and left out. Written back as WKT (shortened for a cell) or GeoJSON.
 */
export type Coord = [number, number];
export type Geometry =
  | { type: 'Point'; coordinates: Coord | null }
  | { type: 'LineString'; coordinates: Coord[] }
  | { type: 'Polygon'; coordinates: Coord[][] }
  | { type: 'MultiPoint'; coordinates: Coord[] }
  | { type: 'MultiLineString'; coordinates: Coord[][] }
  | { type: 'MultiPolygon'; coordinates: Coord[][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };
export interface Spatial {
  geometry: Geometry;
  srid?: number;
}

const TYPES = [
  '',
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
] as const;

/** Reads EWKB or WKB written in hexadecimal; throws when it is not well formed. */
export function readWkb(hex: string): Spatial {
  const text = hex.trim().replace(/^\\x/i, '');
  if (!/^([0-9a-f]{2})+$/i.test(text)) throw new Error('Not WKB');
  const bytes = new Uint8Array(text.length / 2);
  for (let at = 0; at < bytes.length; at++)
    bytes[at] = parseInt(text.slice(at * 2, at * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  let at = 0;
  let srid: number | undefined;
  const read = (): Geometry => {
    if (at + 5 > bytes.length) throw new Error('Not WKB');
    const little = bytes[at] === 1;
    if (bytes[at] > 1) throw new Error('Not WKB');
    at += 1;
    const word = () => {
      if (at + 4 > bytes.length) throw new Error('Not WKB');
      const value = view.getUint32(at, little);
      at += 4;
      return value;
    };
    let kind = word();
    const ewkbZ = (kind & 0x80000000) !== 0;
    const ewkbM = (kind & 0x40000000) !== 0;
    if (kind & 0x20000000) srid = word();
    kind &= 0x0fffffff;
    // ISO WKB: 1001 Z, 2001 M, 3001 ZM.
    const iso = Math.floor(kind / 1000);
    const dimensions =
      2 + (ewkbZ || iso === 1 || iso === 3 ? 1 : 0) + (ewkbM || iso === 2 || iso === 3 ? 1 : 0);
    const type = TYPES[kind % 1000];
    if (!type) throw new Error('Not WKB');
    const point = (): Coord => {
      if (at + dimensions * 8 > bytes.length) throw new Error('Not WKB');
      const coord: Coord = [view.getFloat64(at, little), view.getFloat64(at + 8, little)];
      at += dimensions * 8;
      return coord;
    };
    const points = () => Array.from({ length: word() }, point);
    switch (type) {
      case 'Point': {
        const coord = point();
        return { type, coordinates: Number.isNaN(coord[0]) ? null : coord };
      }
      case 'LineString':
        return { type, coordinates: points() };
      case 'Polygon':
        return { type, coordinates: Array.from({ length: word() }, points) };
      default: {
        const parts = Array.from({ length: word() }, read);
        if (type === 'GeometryCollection') return { type, geometries: parts };
        if (type === 'MultiPoint')
          return {
            type,
            coordinates: parts.flatMap((p) =>
              p.type === 'Point' && p.coordinates ? [p.coordinates] : [],
            ),
          };
        if (type === 'MultiLineString')
          return {
            type,
            coordinates: parts.flatMap((p) => (p.type === 'LineString' ? [p.coordinates] : [])),
          };
        return {
          type,
          coordinates: parts.flatMap((p) => (p.type === 'Polygon' ? [p.coordinates] : [])),
        };
      }
    }
  };
  const geometry = read();
  return srid ? { geometry, srid } : { geometry };
}

/** Reads WKT or EWKT (`SRID=4326;POINT(1 2)`); throws when it is not well formed. */
export function readWkt(source: string): Spatial {
  let text = source.trim();
  let srid: number | undefined;
  const prefix = /^SRID=(\d+);/i.exec(text);
  if (prefix) {
    srid = Number(prefix[1]);
    text = text.slice(prefix[0].length);
  }
  let at = 0;
  const skip = () => {
    while (/\s/.test(text[at] ?? '')) at++;
  };
  const expect = (char: string) => {
    skip();
    if (text[at] !== char) throw new Error('Not WKT');
    at++;
  };
  const word = () => {
    skip();
    const match = /^[A-Za-z]+/.exec(text.slice(at));
    if (!match) throw new Error('Not WKT');
    at += match[0].length;
    return match[0].toUpperCase();
  };
  const peekEmpty = () => {
    skip();
    if (/^EMPTY/i.test(text.slice(at))) {
      at += 5;
      return true;
    }
    return false;
  };
  const coord = (): Coord => {
    skip();
    const match = /^[-+0-9.eE]+(\s+[-+0-9.eE]+)+/.exec(text.slice(at));
    if (!match) throw new Error('Not WKT');
    at += match[0].length;
    const [x, y] = match[0].trim().split(/\s+/).map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Not WKT');
    return [x, y];
  };
  const list = <T>(item: () => T): T[] => {
    if (peekEmpty()) return [];
    expect('(');
    const items = [item()];
    for (skip(); text[at] === ','; skip()) {
      at++;
      items.push(item());
    }
    expect(')');
    return items;
  };
  const ring = () => list(coord);
  // A point of a multipoint may come in parentheses or not.
  const loosePoint = () => {
    skip();
    if (text[at] !== '(') return coord();
    at++;
    const point = coord();
    expect(')');
    return point;
  };
  const geometry = (): Geometry => {
    let name = word();
    while (/^(Z|M|ZM)$/.test(name)) name = word();
    skip();
    const suffix = /^(ZM|Z|M)\b/i.exec(text.slice(at));
    if (suffix) at += suffix[0].length;
    switch (name) {
      case 'POINT': {
        const [point] = list(coord);
        return { type: 'Point', coordinates: point ?? null };
      }
      case 'LINESTRING':
        return { type: 'LineString', coordinates: list(coord) };
      case 'POLYGON':
        return { type: 'Polygon', coordinates: list(ring) };
      case 'MULTIPOINT':
        return { type: 'MultiPoint', coordinates: list(loosePoint) };
      case 'MULTILINESTRING':
        return { type: 'MultiLineString', coordinates: list(ring) };
      case 'MULTIPOLYGON':
        return { type: 'MultiPolygon', coordinates: list(() => list(ring)) };
      case 'GEOMETRYCOLLECTION':
        return { type: 'GeometryCollection', geometries: list(geometry) };
      default:
        throw new Error('Not WKT');
    }
  };
  const read = geometry();
  skip();
  if (at !== text.length) throw new Error('Not WKT');
  return srid ? { geometry: read, srid } : { geometry: read };
}

const WKT_START = /^\s*(SRID=\d+;)?\s*(POINT|LINESTRING|POLYGON|MULTI|GEOMETRYCOLLECTION)/i;

/** The geometry of a cell: a spatial value of a driver, or WKT text; none for anything else. */
export function geometryOf(value: unknown): Spatial | undefined {
  try {
    if (value && typeof value === 'object' && (value as { $t?: unknown }).$t === 'spatial') {
      const text = String((value as { v?: unknown }).v ?? '');
      return WKT_START.test(text) ? readWkt(text) : readWkb(text);
    }
    if (typeof value === 'string' && WKT_START.test(value)) return readWkt(value);
  } catch {
    return undefined;
  }
  return undefined;
}

const number = (value: number) => String(Math.round(value * 1e9) / 1e9);
const pair = ([x, y]: Coord) => `${number(x)} ${number(y)}`;
const group = <T>(items: readonly T[], each: (item: T) => string) =>
  items.length ? `(${items.map(each).join(', ')})` : ' EMPTY';

/** A geometry as WKT. */
export function toWkt(geometry: Geometry): string {
  const name = geometry.type.toUpperCase();
  switch (geometry.type) {
    case 'Point':
      return geometry.coordinates ? `POINT (${pair(geometry.coordinates)})` : 'POINT EMPTY';
    case 'LineString':
    case 'MultiPoint':
      return `${name}${group(geometry.coordinates, pair).replace(/^\(/, ' (')}`;
    case 'Polygon':
    case 'MultiLineString':
      return `${name}${group(geometry.coordinates, (ring) => group(ring, pair)).replace(/^\(/, ' (')}`;
    case 'MultiPolygon':
      return `${name}${group(geometry.coordinates, (polygon) => group(polygon, (ring) => group(ring, pair))).replace(/^\(/, ' (')}`;
    case 'GeometryCollection':
      return `${name}${group(geometry.geometries, toWkt).replace(/^\(/, ' (')}`;
  }
}

/** The WKT a cell shows: cut, with its SRID first when it has one. */
export function shortWkt(spatial: Spatial, length = 60): string {
  const wkt = toWkt(spatial.geometry);
  const text = spatial.srid ? `SRID=${spatial.srid};${wkt}` : wkt;
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** A geometry as GeoJSON. */
export function toGeoJson(geometry: Geometry): Record<string, unknown> {
  if (geometry.type === 'GeometryCollection')
    return { type: geometry.type, geometries: geometry.geometries.map(toGeoJson) };
  if (geometry.type === 'Point') return { type: 'Point', coordinates: geometry.coordinates ?? [] };
  return { type: geometry.type, coordinates: geometry.coordinates };
}

/** Every coordinate of a geometry. */
export function coordinates(geometry: Geometry): Coord[] {
  switch (geometry.type) {
    case 'Point':
      return geometry.coordinates ? [geometry.coordinates] : [];
    case 'LineString':
    case 'MultiPoint':
      return geometry.coordinates;
    case 'Polygon':
    case 'MultiLineString':
      return geometry.coordinates.flat();
    case 'MultiPolygon':
      return geometry.coordinates.flat(2);
    case 'GeometryCollection':
      return geometry.geometries.flatMap(coordinates);
  }
}

/** The box around some coordinates, `[minX, minY, maxX, maxY]`; none without any. */
export function bbox(points: readonly Coord[]): [number, number, number, number] | undefined {
  if (!points.length) return undefined;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
