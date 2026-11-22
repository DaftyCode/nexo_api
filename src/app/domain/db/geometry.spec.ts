import { describe, expect, it } from 'vitest';
import {
  Geometry,
  bbox,
  coordinates,
  geometryOf,
  readWkb,
  readWkt,
  shortWkt,
  toGeoJson,
  toWkt,
} from './geometry';
import { formatCell } from './grid/cells';

/** WKB in hexadecimal, little endian, as the tests write it. */
const u32 = (value: number) =>
  [0, 8, 16, 24].map((shift) => ((value >>> shift) & 0xff).toString(16).padStart(2, '0')).join('');
const f64 = (value: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return [...new Uint8Array(view.buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};
const points = (list: number[][]) =>
  u32(list.length) + list.map(([x, y]) => f64(x) + f64(y)).join('');

describe('reading geometries', () => {
  it('reads the EWKB of each engine, with its SRID', () => {
    // PostGIS: ST_GeomFromText('POINT(1 2)', 4326); MySQL and SQL Server come to the same.
    expect(readWkb('0101000020E6100000000000000000F03F0000000000000040')).toEqual({
      geometry: { type: 'Point', coordinates: [1, 2] },
      srid: 4326,
    });
    const line = `01${u32(2)}${points([
      [0, 0],
      [3, 4],
    ])}`;
    expect(readWkb(line)).toEqual({
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [3, 4],
        ],
      },
    });
    const square = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 0],
    ];
    const polygon = `01${u32(3)}${u32(1)}${points(square)}`;
    expect(readWkb(polygon).geometry).toEqual({ type: 'Polygon', coordinates: [square] });
    const multi = `01${u32(6)}${u32(2)}${polygon}${polygon}`;
    expect(readWkb(multi).geometry).toMatchObject({
      type: 'MultiPolygon',
      coordinates: [[square], [square]],
    });
    const point = `01${u32(1)}${f64(5)}${f64(6)}`;
    const collection = `01${u32(7)}${u32(2)}${point}${line}`;
    expect(readWkb(collection).geometry).toMatchObject({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point' }, { type: 'LineString' }],
    });
    expect(readWkb(`01${u32(4)}${u32(1)}${point}`).geometry).toEqual({
      type: 'MultiPoint',
      coordinates: [[5, 6]],
    });
    expect(readWkb(`01${u32(5)}${u32(1)}${line}`).geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [3, 4],
        ],
      ],
    });
    // Z and M are read and left out: EWKB flags and ISO types.
    const z = `01${u32(0x80000001)}${f64(1)}${f64(2)}${f64(3)}`;
    expect(readWkb(z).geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
    const zm = `01${u32(3001)}${f64(1)}${f64(2)}${f64(3)}${f64(4)}`;
    expect(readWkb(zm).geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
    // Big endian, and an empty point.
    expect(readWkb('00000000013FF00000000000004000000000000000').geometry).toEqual({
      type: 'Point',
      coordinates: [1, 2],
    });
    expect(readWkb(`01${u32(1)}000000000000F87F000000000000F87F`).geometry).toEqual({
      type: 'Point',
      coordinates: null,
    });
    for (const broken of ['', 'xyz', '02', `01${u32(9)}`, `01${u32(1)}${f64(1)}`, '01'])
      expect(() => readWkb(broken), broken).toThrow();
  });

  it('reads WKT and EWKT, empty and with Z', () => {
    expect(readWkt('SRID=3857;POINT(10 20)')).toEqual({
      geometry: { type: 'Point', coordinates: [10, 20] },
      srid: 3857,
    });
    expect(readWkt('POINT Z (1 2 3)').geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(readWkt('point empty').geometry).toEqual({ type: 'Point', coordinates: null });
    expect(readWkt('LINESTRING (0 0, 1 1)').geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(readWkt('POLYGON ((0 0, 1 0, 1 1, 0 0))').geometry.type).toBe('Polygon');
    expect(readWkt('MULTIPOINT ((1 2), 3 4)').geometry).toEqual({
      type: 'MultiPoint',
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(readWkt('MULTILINESTRING ((0 0, 1 1))').geometry.type).toBe('MultiLineString');
    expect(readWkt('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))').geometry.type).toBe('MultiPolygon');
    expect(readWkt('GEOMETRYCOLLECTION (POINT (1 2), LINESTRING EMPTY)').geometry).toEqual({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 2] },
        { type: 'LineString', coordinates: [] },
      ],
    });
    for (const broken of ['CIRCLE (1)', 'POINT (1)', 'POINT (1 2', 'POINT (1 2) x', 'POINT (a b)'])
      expect(() => readWkt(broken), broken).toThrow();
  });

  it('finds the geometry of a cell, and writes it as WKT, short WKT and GeoJSON', () => {
    const cell = { $t: 'spatial', v: '0101000020E6100000000000000000F03F0000000000000040' };
    const spatial = geometryOf(cell)!;
    expect(shortWkt(spatial)).toBe('SRID=4326;POINT (1 2)');
    expect(
      shortWkt(
        {
          geometry: {
            type: 'LineString',
            coordinates: Array.from({ length: 30 }, (_, i) => [i, i] as [number, number]),
          },
        },
        20,
      ),
    ).toHaveLength(20);
    expect(geometryOf({ $t: 'spatial', v: 'POINT (1 2)' })?.geometry).toEqual({
      type: 'Point',
      coordinates: [1, 2],
    });
    expect(geometryOf('POLYGON ((0 0, 1 0, 1 1, 0 0))')?.geometry.type).toBe('Polygon');
    expect(geometryOf({ $t: 'spatial', v: 'zz' })).toBeUndefined();
    expect(geometryOf('a text')).toBeUndefined();
    expect(geometryOf(7)).toBeUndefined();
    const all: Geometry[] = [
      { type: 'Point', coordinates: null },
      { type: 'MultiPoint', coordinates: [[1, 2]] },
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      { type: 'MultiLineString', coordinates: [] },
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
      {
        type: 'GeometryCollection',
        geometries: [{ type: 'Point', coordinates: [0.1234567891234, 2] }],
      },
    ];
    expect(all.map(toWkt)).toEqual([
      'POINT EMPTY',
      'MULTIPOINT (1 2)',
      'POLYGON ((0 0, 1 0, 0 0))',
      'MULTILINESTRING EMPTY',
      'MULTIPOLYGON (((0 0, 1 1, 0 0)))',
      'GEOMETRYCOLLECTION (POINT (0.123456789 2))',
    ]);
    expect(toGeoJson(all[0])).toEqual({ type: 'Point', coordinates: [] });
    expect(toGeoJson(all[5])).toEqual({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [0.1234567891234, 2] }],
    });
    expect(all.flatMap(coordinates)).toHaveLength(8);
    expect(
      bbox([
        [1, 5],
        [-2, 3],
      ]),
    ).toEqual([-2, 3, 1, 5]);
    expect(bbox([])).toBeUndefined();
    // A cell of the grid shows the WKT.
    expect(formatCell(cell).text).toBe('SRID=4326;POINT (1 2)');
  });
});
