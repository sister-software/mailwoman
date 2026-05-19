-- Hand-crafted TIGER fixture for the @mailwoman/corpus tiger adapter.
--
-- License: US TIGER/Line products are public-domain. All entries are
-- public-knowledge place names; LINEARID + GEOID values are illustrative
-- and do not match the real Census shapefile records.
--
-- The mailwoman tiger adapter expects two tables an operator builds
-- from the raw TIGER shapefiles (via ogr2ogr / shp2pgsql / similar):
--   tiger_streets  ← ADDRFEAT (street segments with house-number ranges)
--   tiger_places   ← PLACE   (cities, towns, CDPs)
-- Column names match the canonical TIGER column names so the table can be
-- populated by `ogr2ogr -f SQLite tiger.db addrfeat.shp -nln tiger_streets`.

CREATE TABLE tiger_streets (
  linearid TEXT PRIMARY KEY,    -- TIGER LINEARID (street-segment id)
  fullname TEXT NOT NULL,       -- Street name as it appears on the envelope, e.g. "S Main St"
  zipl     TEXT,                -- Left-side 5-digit ZIP
  zipr     TEXT,                -- Right-side 5-digit ZIP
  statefp  TEXT NOT NULL        -- 2-digit state FIPS code (e.g. "50" = VT)
);

CREATE INDEX tiger_streets_statefp ON tiger_streets (statefp);

CREATE TABLE tiger_places (
  geoid    TEXT PRIMARY KEY,    -- 7-char (state_FIPS + place_FIPS)
  name     TEXT NOT NULL,       -- "Burlington"
  statefp  TEXT NOT NULL,       -- "50"
  lsad     TEXT                 -- Legal/Statistical Area Description (00 = city, 25 = town, etc.)
);

CREATE INDEX tiger_places_statefp ON tiger_places (statefp);

-- ===========================================================================
-- Streets (with house-number-range ZIPs where known)
-- ===========================================================================

INSERT INTO tiger_streets (linearid, fullname, zipl, zipr, statefp) VALUES
  -- Oregon (statefp 41)
  ('110000001', 'SE Salmon St',   '97215', '97215', '41'),
  ('110000002', 'SW Broadway',    '97205', '97205', '41'),
  ('110000003', 'NE Alberta St',  '97211', '97211', '41'),
  -- Vermont (statefp 50)
  ('110000010', 'Church St',      '05401', '05401', '50'),
  ('110000011', 'Main St',        '05401', '05401', '50'),
  -- Wyoming (statefp 56) — held out for val/test
  ('110000020', 'Capitol Ave',    '82001', '82001', '56'),
  -- California (statefp 06)
  ('110000030', 'Market St',      '94105', '94105', '06');

-- ===========================================================================
-- Places (cities + CDPs)
-- ===========================================================================

INSERT INTO tiger_places (geoid, name, statefp, lsad) VALUES
  ('4159000', 'Portland',        '41', '25'),  -- City
  ('5010675', 'Burlington',      '50', '25'),  -- City
  ('5683575', 'Cheyenne',        '56', '25'),  -- Wyoming, held out
  ('0667000', 'San Francisco',   '06', '25');  -- City
