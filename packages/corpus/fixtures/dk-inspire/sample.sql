-- Six real rows of Klimadatastyrelsen's `ad_inspire.gpkg`, with the publisher's own DDL.
--
-- The seed is SQL rather than a committed `.gpkg` so the schema a test asserts against is the
-- schema a reviewer reads. `buildFixtureGeoPackage` in `adapter.test.ts` executes it into a
-- scratch database, which is what the adapter opens.
--
-- `CREATE TABLE` is copied byte-for-byte from `sqlite_master` of the 391,258,112-byte
-- `ad_inspire.gpkg`, so a column rename upstream fails the test rather than passing silently.
-- Only the three tables the adapter reads are present; the GeoPackage declares five.
--
-- Each `address` row below is the publisher's row at that `objectid`, and the six cover the four
-- designator combinations the file carries: no floor and no door, a floor alone, a floor with a
-- door, and a door with no floor. That last shape holds 967 of the 599,999 rows and is the one a
-- number-plus-suffix join silently drops.

PRAGMA application_id = 1196444487;
PRAGMA user_version = 10201;

CREATE TABLE gpkg_contents (
  table_name TEXT NOT NULL PRIMARY KEY,
  data_type TEXT NOT NULL,
  identifier TEXT UNIQUE,
  description TEXT DEFAULT '',
  last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  min_x DOUBLE,
  min_y DOUBLE,
  max_x DOUBLE,
  max_y DOUBLE,
  srs_id INTEGER
);

CREATE TABLE "address" (
  "objectid" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "inspireid" TEXT NOT NULL,
  "alternativeidentifier" TEXT,
  "position_default" TEXT NOT NULL,
  "position_geometry" POINT,
  "position_method" TEXT NOT NULL,
  "position_specification" TEXT NOT NULL,
  "status" TEXT,
  "locator_designator_1_designator" TEXT,
  "locator_designator_1_type" TEXT,
  "locator_designator_2_designator" TEXT,
  "locator_designator_2_type" TEXT,
  "locator_designator_3_designator" TEXT,
  "locator_designator_3_type" TEXT,
  "locator_level" TEXT NOT NULL,
  "locator_name_name" TEXT,
  "locator_name_type" TEXT,
  "locator_withinscopeof_addressareaname" TEXT,
  "locator_withinscopeof_adminunitname" TEXT,
  "locator_withinscopeof_postaldescriptor" TEXT,
  "locator_withinscopeof_thoroughfarename" TEXT,
  "validfrom" DATETIME NOT NULL,
  "validto" DATETIME,
  "beginlifespanversion" DATETIME NOT NULL,
  "endlifespanversion" DATETIME,
  "component_addressareaname_1" TEXT,
  "component_addressareaname_2" TEXT,
  "component_addressareaname_3" TEXT,
  "component_adminunitname_1" TEXT,
  "component_adminunitname_2" TEXT,
  "component_adminunitname_3" TEXT,
  "component_adminunitname_4" TEXT,
  "component_adminunitname_5" TEXT,
  "component_adminunitname_6" TEXT,
  "component_postaldescriptor" TEXT,
  "component_thoroughfarename" TEXT,
  "parentaddress" TEXT,
  "parcel" TEXT,
  "building" TEXT
);

CREATE TABLE "postaldescriptor" (
  "objectid" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "postname" TEXT,
  "postcode" TEXT,
  "validto" DATETIME,
  "inspireid" TEXT,
  "alternativeidentifier" TEXT,
  "beginlifespanversion" DATETIME NOT NULL,
  "endlifespanversion" DATETIME,
  "status" TEXT,
  "validfrom" DATETIME NOT NULL,
  "situatedwithin_addressareaname" TEXT,
  "situatedwithin_adminunitname" TEXT,
  "situatedwithin_postaldescriptor" TEXT,
  "situatedwithin_thoroughfarename" TEXT,
  "geometry" MULTIPOLYGON
);

CREATE TABLE "thoroughfarename" (
  "objectid" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "validto" DATETIME,
  "inspireid" TEXT,
  "alternativeidentifier" TEXT,
  "beginlifespanversion" DATETIME NOT NULL,
  "endlifespanversion" DATETIME,
  "status" TEXT,
  "validfrom" DATETIME NOT NULL,
  "name_name" TEXT NOT NULL,
  "name_nameparts_part" TEXT,
  "name_nameparts_type" TEXT,
  "situatedwithin_addressareaname" TEXT,
  "situatedwithin_adminunitname" TEXT,
  "situatedwithin_postaldescriptor" TEXT,
  "situatedwithin_thoroughfarename" TEXT,
  "transportlink" TEXT
);

INSERT INTO gpkg_contents (table_name, data_type, description, last_change, srs_id) VALUES
  ('address', 'features', 'An identification of the fixed location of property by means of a structured composition of geographic names and identifiers.', '2022-10-26T11:29:50.964Z', 25832),
  ('postaldescriptor', 'features', 'An address component which represents the identification of a subdivision of addresses and postal delivery points in a country, region or city for postal purposes.', '2026-09-27T02:15:18.337Z', 25832),
  ('thoroughfarename', 'attributes', 'An address component which represents the name of a passage or way through from one location to another.', '2026-09-27T02:15:20.823Z', NULL);

INSERT INTO "thoroughfarename" ("objectid", "inspireid", "name_name", "beginlifespanversion", "validfrom") VALUES
  (13138, '35c543d7-daf5-4e7a-8219-f0da78f0670e', 'Nykobbelvej',  '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (50723, '7f002f13-f0ce-48f8-adf7-995487b1e4bf', 'Viborgvej',    '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (65424, '59cf4a2d-e0c3-48d1-bd43-215a48fff5c6', 'Knivholtvej',  '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (75339, 'd6c108bb-d0ee-4298-83a6-8b730476edc9', 'Vestergade',   '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (20797, 'adcd0a5e-4834-42e3-a66e-25f57d2f658d', 'Klosterhaven', '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (50605, '12fd79ad-27fe-47bc-8bd4-9cdb41f136f8', 'Slagelsevej',  '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z');

INSERT INTO "postaldescriptor" ("objectid", "inspireid", "postcode", "postname", "beginlifespanversion", "validfrom") VALUES
  (228, '5480806a-435e-4a36-b904-a73ea8831e0d', '4200', 'Slagelse',   '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (624, 'ba6f134c-bf01-44ed-8755-6e2f1f5b1a58', '8210', 'Aarhus V',   '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (691, '4d15c83f-4c34-4819-869b-d372e73f62a0', '2720', 'Vanløse',    '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (410, '8ac41ccb-cbbc-494d-9c2f-722970ffe3dc', '7770', 'Vestervig',  '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (574, 'e7a48dd2-5591-46ad-816a-b9576e3efb80', '8620', 'Kjellerup',  '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z'),
  (899, 'e9faf8d7-e4d2-406a-bbb3-7298957729a9', '4400', 'Kalundborg', '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z');

INSERT INTO "address" (
  "objectid", "inspireid", "position_default", "position_method", "position_specification", "status",
  "locator_designator_1_designator", "locator_designator_1_type",
  "locator_designator_2_designator", "locator_designator_2_type",
  "locator_designator_3_designator", "locator_designator_3_type",
  "locator_level", "validfrom", "beginlifespanversion",
  "component_adminunitname_2", "component_adminunitname_3",
  "component_postaldescriptor", "component_thoroughfarename"
) VALUES
  -- Neither a floor nor a door: the shape 544,970 of the 599,999 rows carry.
  (1, '0a3f5084-5ced-32b8-e044-0003ba298018', '1', 'byotherparty', 'addressarea', 'current',
   '2A', 'entrancedooridentifier', NULL, 'flooridentifier', NULL, 'unitidentifier',
   'accesslevel', '2024-10-08T09:57:32.322Z', '2024-10-08T09:57:32.322Z',
   '389100', '389144', '5480806a-435e-4a36-b904-a73ea8831e0d', '35c543d7-daf5-4e7a-8219-f0da78f0670e'),
  -- A floor and no door, 21,840 rows. `st` is `stuen`, the ground floor.
  (6, '0a3f5097-24af-32b8-e044-0003ba298018', '1', 'byotherparty', 'addressarea', 'current',
   '149', 'entrancedooridentifier', 'st', 'flooridentifier', NULL, 'unitidentifier',
   'accesslevel', '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z',
   '389101', '389151', 'ba6f134c-bf01-44ed-8755-6e2f1f5b1a58', '7f002f13-f0ce-48f8-adf7-995487b1e4bf'),
  -- A floor and a door, 32,222 rows. `tv` is `til venstre`, the left-hand door.
  (34, '0a3f507a-a9b4-32b8-e044-0003ba298018', '1', 'byotherparty', 'addressarea', 'current',
   '9', 'entrancedooridentifier', 'st', 'flooridentifier', 'tv', 'unitidentifier',
   'accesslevel', '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z',
   '389099', '389101', '4d15c83f-4c34-4819-869b-d372e73f62a0', '59cf4a2d-e0c3-48d1-bd43-215a48fff5c6'),
  -- A numeric floor beside a lettered house number.
  (40, 'ca117209-60d7-47f0-8ced-875c7ea131b7', '1', 'byotherparty', 'addressarea', 'current',
   '6A', 'entrancedooridentifier', '1', 'flooridentifier', NULL, 'unitidentifier',
   'accesslevel', '2022-05-09T07:08:52.828Z', '2022-05-09T07:08:52.828Z',
   '389098', '389198', '8ac41ccb-cbbc-494d-9c2f-722970ffe3dc', 'd6c108bb-d0ee-4298-83a6-8b730476edc9'),
  -- A door with no floor, 967 rows. The door here is a number rather than a side.
  (1935, '0a3f5097-95ee-32b8-e044-0003ba298018', '1', 'byotherparty', 'addressarea', 'current',
   '1', 'entrancedooridentifier', NULL, 'flooridentifier', '6', 'unitidentifier',
   'accesslevel', '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z',
   '389101', '389152', 'e7a48dd2-5591-46ad-816a-b9576e3efb80', 'adcd0a5e-4834-42e3-a66e-25f57d2f658d'),
  -- A door with no floor again, this one a side.
  (3402, '0a3f5083-9a40-32b8-e044-0003ba298018', '1', 'byotherparty', 'addressarea', 'current',
   '68A', 'entrancedooridentifier', NULL, 'flooridentifier', 'tv', 'unitidentifier',
   'accesslevel', '2022-05-09T07:07:03.239Z', '2022-05-09T07:07:03.239Z',
   '389100', '389326', 'e9faf8d7-e4d2-406a-bbb3-7298957729a9', '12fd79ad-27fe-47bc-8bd4-9cdb41f136f8');
