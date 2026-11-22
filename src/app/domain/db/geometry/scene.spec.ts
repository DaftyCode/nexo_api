import { describe, expect, it } from 'vitest';
import { MAX_FIGURES, project, spatialScene } from './scene';
import { defaultExportOptions, exportWriter } from '../transfer/export';

describe('the spatial scene', () => {
  it('draws WGS 84 in Web Mercator, north up, and other systems in their units', () => {
    const [x, y] = project([180, 0], 'geographic');
    expect(x).toBeCloseTo(20037508.34, 1);
    expect(y).toBeCloseTo(0);
    expect(project([0, 85.06], 'geographic')[1]).toBeCloseTo(-20037508.34, 0);
    expect(project([3, 4], 'own')).toEqual([3, -4]);
    const scene = spatialScene([
      { geometry: { type: 'Point', coordinates: [0, 0] }, srid: 4326 },
      undefined,
      {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        srid: 4326,
      },
      {
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
        srid: 4269,
      },
      {
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'MultiPoint', coordinates: [[1, 1]] },
            { type: 'LineString', coordinates: [] },
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
            { type: 'Point', coordinates: null },
          ],
        },
      },
    ]);
    expect(scene.units).toBe('geographic');
    expect(scene.srids).toEqual([4326, 4269]);
    expect(scene.figures.map((each) => [each.row, each.shape])).toEqual([
      [0, 'point'],
      [2, 'area'],
      [3, 'line'],
      [4, 'point'],
      [4, 'area'],
    ]);
    expect(scene.figures[1].d).toMatch(/^M 0 0 L .* Z$/);
    expect(scene.view!.width).toBeGreaterThan(0);
    const own = spatialScene([{ geometry: { type: 'Point', coordinates: [5, 5] }, srid: 25830 }]);
    expect(own.units).toBe('own');
    expect(
      spatialScene([{ geometry: { type: 'Point', coordinates: [5, 5] }, srid: 3857 }]).units,
    ).toBe('mercator');
    expect(spatialScene([]).view).toBeUndefined();
    const many = spatialScene(
      Array.from({ length: MAX_FIGURES + 10 }, () => ({
        geometry: { type: 'Point' as const, coordinates: [1, 1] as [number, number] },
      })),
    );
    expect(many.figures).toHaveLength(MAX_FIGURES);
  });

  it('exports rows as GeoJSON features, the other cells as properties', () => {
    const writer = exportWriter(
      'geojson',
      {
        columns: [
          { name: 'id', kind: 'integer', typeName: 'int' },
          { name: 'shape', kind: 'spatial', typeName: 'geometry' },
        ],
        table: 't',
        style: { name: 'postgresql', quoteOpen: '"', quoteClose: '"' },
      },
      defaultExportOptions(),
    );
    const text =
      writer.start() +
      writer.page([
        [1, 'POINT (1 2)'],
        [2, null],
      ]) +
      writer.end();
    expect(JSON.parse(text)).toEqual({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { id: 1 },
        },
        { type: 'Feature', geometry: null, properties: { id: 2, shape: null } },
      ],
    });
    const empty = exportWriter(
      'geojson',
      { columns: [], table: 't', style: { name: '', quoteOpen: '"', quoteClose: '"' } },
      defaultExportOptions(),
    );
    expect(JSON.parse(empty.start() + empty.end())).toEqual({
      type: 'FeatureCollection',
      features: [],
    });
  });
});
