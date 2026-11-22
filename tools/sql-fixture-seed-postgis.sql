-- PostGIS data of the spatial viewer's tests (DB-29): points, lines and polygons in WGS 84,
-- and the same point in every engine's tests (POINT(1 2), SRID 4326).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE public.places (
  id integer PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  shape geometry(Geometry, 4326) NOT NULL
);
INSERT INTO public.places VALUES
  (1, 'Lima', 'city', ST_GeomFromText('POINT(-77.0428 -12.0464)', 4326)),
  (2, 'Quito', 'city', ST_GeomFromText('POINT(-78.4678 -0.1807)', 4326)),
  (3, 'Andes road', 'road', ST_GeomFromText('LINESTRING(-78.4678 -0.1807, -77.0428 -12.0464)', 4326)),
  (4, 'Park', 'area', ST_GeomFromText('POLYGON((-77.1 -12.1, -77.0 -12.1, -77.0 -12.0, -77.1 -12.1))', 4326)),
  (5, 'Same point', 'test', ST_GeomFromText('POINT(1 2)', 4326));
