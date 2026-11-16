-- The data of the MySQL and MariaDB driver tests (tools/sql-fixture.sh), in the database
-- `shop`: related tables and every kind of object the tree shows, a table of 100 000 rows, a
-- table with a column of each type with known values, and dates MySQL calls zero.
-- The client that loads it would read this file as Latin-1.
SET NAMES utf8mb4;
CREATE TABLE customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(200) NOT NULL UNIQUE,
    name VARCHAR(100),
    created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) COMMENT 'People who buy';

CREATE TABLE orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer INT NOT NULL,
    status ENUM('new', 'paid', 'sent') NOT NULL DEFAULT 'new',
    total DECIMAL(12, 2) NOT NULL,
    CONSTRAINT orders_customer_fkey FOREIGN KEY (customer) REFERENCES customers (id) ON DELETE CASCADE,
    CONSTRAINT orders_total_small CHECK (total < 1000000)
);
CREATE INDEX orders_status ON orders (status);
CREATE VIEW open_orders AS SELECT id, customer, total FROM orders WHERE status <> 'sent';

DELIMITER //
CREATE FUNCTION order_count(customer_id INT) RETURNS BIGINT READS SQL DATA
    RETURN (SELECT COUNT(*) FROM orders WHERE customer = customer_id)//
CREATE PROCEDURE mark_sent(IN order_id BIGINT) MODIFIES SQL DATA
    UPDATE orders SET status = 'sent' WHERE id = order_id//
CREATE PROCEDURE two_results() READS SQL DATA
BEGIN
    SELECT 1 AS first;
    SELECT 'two' AS second, 2 AS number;
END//
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW SET NEW.total = NEW.total//
DELIMITER ;
CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM orders WHERE 1 = 0;

INSERT INTO customers (email, name) VALUES ('ana@example.com', 'Ana'), ('luis@example.com', 'Luis');
INSERT INTO orders (customer, status, total) VALUES (1, 'paid', 120.50), (1, 'new', 9.99), (2, 'sent', 0);

-- 100 000 rows, from the digits crossed five times (no recursion limits to raise).
CREATE TABLE digits (d INT);
INSERT INTO digits VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);
CREATE TABLE numbers (n INT PRIMARY KEY, label VARCHAR(20) NOT NULL);
INSERT INTO numbers
SELECT n, CONCAT('row ', n) FROM (
    SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 + 1 AS n
    FROM digits a, digits b, digits c, digits e, digits f
) AS sequence;
DROP TABLE digits;

CREATE TABLE every_type (
    id INT PRIMARY KEY,
    tiny TINYINT, small SMALLINT, medium MEDIUMINT, normal INT, big BIGINT,
    unsigned_big BIGINT UNSIGNED, money DECIMAL(30, 9), real_value FLOAT, double_value DOUBLE,
    flag BIT(1), bits BIT(16), day DATE, moment DATETIME(6), stamp TIMESTAMP NULL, clock TIME(6),
    year_value YEAR, word VARCHAR(40), letters CHAR(3), body TEXT, doc JSON,
    status ENUM('a', 'b'), tags SET('x', 'y'), raw VARBINARY(16), blob_value BLOB, place POINT
);
INSERT INTO every_type VALUES (
    1, -128, -32768, -8388608, -2147483648, -9223372036854775808, 18446744073709551615,
    12345678901234567890.123456789, 1.5, 2.25, b'1', b'0000000100000001', '2026-11-16',
    '2026-11-16 10:20:30.123456', '2026-11-16 10:20:30', '800:00:00.5', 2026, 'año', 'abc',
    'long text', '{"a": [1, 2]}', 'b', 'x,y', 0x00FF, 0x0102, ST_GeomFromText('POINT(1 2)')
);
INSERT INTO every_type (id) VALUES (2);

-- Dates MySQL calls zero, which only a lenient mode stores.
SET SESSION sql_mode = '';
CREATE TABLE zero_dates (day DATE, moment DATETIME);
INSERT INTO zero_dates VALUES ('0000-00-00', '0000-00-00 00:00:00');
