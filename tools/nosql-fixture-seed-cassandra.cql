-- The data of the Cassandra tests (tools/nosql-fixture.sh): a keyspace with a table of every
-- type, a table with a partition key of two columns, a clustering key in descending order and
-- a static column, a user type, an index and a function.
CREATE KEYSPACE IF NOT EXISTS shop
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TYPE IF NOT EXISTS shop.address (city text, zip text);

CREATE TABLE IF NOT EXISTS shop.every_type (
  id int PRIMARY KEY,
  a_text text, an_ascii ascii, a_bigint bigint, a_varint varint, a_decimal decimal,
  a_double double, a_float float, a_boolean boolean, a_uuid uuid, a_timeuuid timeuuid,
  a_timestamp timestamp, a_date date, a_time time, a_duration duration, an_inet inet,
  a_blob blob, a_list list<int>, a_set set<text>, a_map map<text, int>,
  a_tuple tuple<int, text>, an_address frozen<address>, a_smallint smallint, a_tinyint tinyint
) WITH comment = 'Every type';

INSERT INTO shop.every_type (id, a_text, an_ascii, a_bigint, a_varint, a_decimal, a_double,
  a_float, a_boolean, a_uuid, a_timeuuid, a_timestamp, a_date, a_time, a_duration, an_inet,
  a_blob, a_list, a_set, a_map, a_tuple, an_address, a_smallint, a_tinyint)
VALUES (1, 'O''Brien', 'abc', 9007199254740993, 123456789012345678901234567890, 1.50,
  1.5, 2.5, true, a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11, 50554d6e-29bb-11e5-b345-feff819cdc9f,
  '2024-01-02T03:04:05.006Z', '2024-01-02', '01:02:03.000000123', 1y2mo3d4h, '10.0.0.1',
  0x0102, [1, 2], {'a', 'b'}, {'k': 1}, (7, 'seven'), {city: 'Lima', zip: '15001'}, 3, 4);
INSERT INTO shop.every_type (id) VALUES (2);

CREATE TABLE IF NOT EXISTS shop.readings (
  sensor text, day date, at timestamp, value double, unit text STATIC,
  PRIMARY KEY ((sensor, day), at)
) WITH CLUSTERING ORDER BY (at DESC) AND default_time_to_live = 0;

INSERT INTO shop.readings (sensor, day, at, value, unit) VALUES ('s1', '2024-01-01', '2024-01-01T10:00:00Z', 1.5, 'C');
INSERT INTO shop.readings (sensor, day, at, value) VALUES ('s1', '2024-01-01', '2024-01-01T11:00:00Z', 2.5);
INSERT INTO shop.readings (sensor, day, at, value) VALUES ('s1', '2024-01-01', '2024-01-01T12:00:00Z', 3.5);
INSERT INTO shop.readings (sensor, day, at, value) VALUES ('s2', '2024-01-01', '2024-01-01T10:00:00Z', 9.0);

CREATE INDEX IF NOT EXISTS readings_value ON shop.readings (value);
