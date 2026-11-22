/**
 * Rows as GeoJSON (DB-29): a feature per row, its geometry the first cell that is one, and
 * the other cells as its properties. A row without a geometry is a feature without one, as
 * GeoJSON allows.
 */
import { geometryOf, toGeoJson } from '../geometry';
import type { ExportWriter } from './export';

export function geojsonWriter(
  names: readonly string[],
  value: (cell: unknown) => unknown,
  bom: string,
): ExportWriter {
  let written = 0;
  const feature = (row: readonly unknown[]) => {
    const at = row.findIndex((cell) => !!geometryOf(cell));
    const spatial = at >= 0 ? geometryOf(row[at]) : undefined;
    const properties = Object.fromEntries(
      names.flatMap((name, index) => (index === at ? [] : [[name, value(row[index])]])),
    );
    return { type: 'Feature', geometry: spatial ? toGeoJson(spatial.geometry) : null, properties };
  };
  return {
    start: () => `${bom}{"type": "FeatureCollection", "features": [`,
    page: (rows) =>
      rows.map((row) => `${written++ ? ',' : ''}\n  ${JSON.stringify(feature(row))}`).join(''),
    end: () => (written ? '\n]}\n' : ']}\n'),
  };
}
