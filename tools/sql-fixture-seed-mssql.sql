-- The data of the SQL Server driver tests (tools/sql-fixture.sh): a database with related
-- tables and every kind of object the tree shows, a table of 100 000 rows and a table with a
-- column of each type, with known values. Batches are separated by GO, as sqlcmd reads them.
CREATE DATABASE shop;
GO
USE shop;
GO
CREATE SCHEMA shop;
GO
CREATE TABLE shop.customers (
    id int IDENTITY(1, 1) NOT NULL CONSTRAINT PK_customers PRIMARY KEY,
    email nvarchar(200) NOT NULL CONSTRAINT UQ_customers_email UNIQUE,
    name nvarchar(100) NULL,
    created datetime2(3) NOT NULL CONSTRAINT DF_customers_created DEFAULT (sysdatetime())
);
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'People who buy',
    @level0type = N'SCHEMA', @level0name = N'shop', @level1type = N'TABLE', @level1name = N'customers';
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Where receipts go',
    @level0type = N'SCHEMA', @level0name = N'shop', @level1type = N'TABLE', @level1name = N'customers',
    @level2type = N'COLUMN', @level2name = N'email';
CREATE TABLE shop.orders (
    id bigint IDENTITY(1, 1) NOT NULL CONSTRAINT PK_orders PRIMARY KEY,
    customer int NOT NULL CONSTRAINT FK_orders_customer REFERENCES shop.customers (id) ON DELETE CASCADE,
    status nvarchar(10) NOT NULL CONSTRAINT DF_orders_status DEFAULT (N'new'),
    total decimal(12, 2) NOT NULL,
    twice AS (total * 2),
    CONSTRAINT CK_orders_total CHECK (total >= 0 AND total < 1000000)
);
CREATE INDEX IX_orders_status ON shop.orders (status) INCLUDE (total) WHERE status <> N'sent';
GO
CREATE VIEW shop.open_orders AS SELECT id, customer, total FROM shop.orders WHERE status <> N'sent';
GO
CREATE PROCEDURE shop.two_results AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, email FROM shop.customers ORDER BY id;
    SELECT id, total FROM shop.orders ORDER BY id;
END;
GO
CREATE FUNCTION shop.order_count (@customer int) RETURNS int AS
BEGIN
    RETURN (SELECT COUNT(*) FROM shop.orders WHERE customer = @customer);
END;
GO
CREATE TRIGGER shop.orders_touch ON shop.orders AFTER UPDATE AS BEGIN SET NOCOUNT ON; END;
GO
CREATE SEQUENCE shop.invoice_numbers AS int START WITH 1000 INCREMENT BY 10;
CREATE SYNONYM shop.buyers FOR shop.customers;
CREATE TYPE shop.positive FROM decimal(12, 2) NOT NULL;
GO
INSERT INTO shop.customers (email, name) VALUES (N'ana@example.com', N'Ana'), (N'luis@example.com', N'Luis');
INSERT INTO shop.orders (customer, status, total) VALUES (1, N'paid', 120.50), (1, N'new', 9.99), (2, N'sent', 0);
CREATE TABLE dbo.numbers (n int NOT NULL PRIMARY KEY, label nvarchar(20) NOT NULL);
INSERT INTO dbo.numbers (n, label)
SELECT TOP (100000) n, N'row ' + CAST(n AS nvarchar(10))
FROM (SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) AS numbered;
CREATE TABLE dbo.every_type (
    id int PRIMARY KEY,
    a_bigint bigint, a_decimal decimal(38, 10), a_money money, a_bit bit, a_datetime datetime,
    a_datetime2 datetime2(7), a_datetimeoffset datetimeoffset(7), a_time time(7), a_date date,
    a_uuid uniqueidentifier, a_varbinary varbinary(16), a_rowversion rowversion, a_xml xml,
    a_hierarchy hierarchyid, a_geography geography, a_text nvarchar(max), a_float float,
    a_real real, a_tinyint tinyint
);
INSERT INTO dbo.every_type (id, a_bigint, a_decimal, a_money, a_bit, a_datetime, a_datetime2, a_datetimeoffset,
    a_time, a_date, a_uuid, a_varbinary, a_xml, a_hierarchy, a_geography, a_text, a_float, a_real, a_tinyint)
VALUES (1, 9223372036854775807, 1234567890123456789012345678.0123456789, 922337203685.4775, 1,
    '2026-11-13T10:20:30.123', '2026-11-13T10:20:30.1234567', '2026-11-13T10:20:30.1234567+02:00',
    '10:20:30.1234567', '2026-11-13', '6F9619FF-8B86-D011-B42D-00C04FC964FF', 0x00FF10, N'<a><b>1</b></a>',
    hierarchyid::Parse('/1/2/'), geography::Point(40.4, -3.7, 4326), REPLICATE(CAST(N'x' AS nvarchar(max)), 10),
    1.5, 2.5, 255);
GO
