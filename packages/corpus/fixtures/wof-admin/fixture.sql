-- Hand-crafted Who's On First admin fixture for the @mailwoman/corpus wof-admin adapter.
--
-- License: CC0 (matches WOF upstream). All entries are public-knowledge place
-- names, ids are illustrative (not the real WOF ids), no proprietary data.
--
-- Mirrors the subset of the real `whosonfirst-data-admin-<cc>-latest.spatial.db`
-- schema that the adapter relies on. The full spatial.db carries many more
-- tables (geometry, geojson, names, concordances) that the adapter does not
-- consult.
--
-- Hierarchy:
--   US > Oregon > Multnomah County > Portland
--   US > Vermont > Burlington
--   FR > Île-de-France > Paris (commune)
--   FR > Auvergne-Rhône-Alpes > Rhône > Lyon

CREATE TABLE spr (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER,
  name        TEXT NOT NULL,
  placetype   TEXT NOT NULL,
  country     TEXT NOT NULL,
  is_current  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX spr_country_placetype ON spr (country, placetype);
CREATE INDEX spr_parent_id ON spr (parent_id);

-- ===========================================================================
-- United States
-- ===========================================================================

INSERT INTO spr (id, parent_id, name, placetype, country) VALUES
  (1001, -1,   'United States', 'country',  'US'),
  (1010, 1001, 'Oregon',        'region',   'US'),
  (1011, 1010, 'Multnomah County', 'county','US'),
  (1012, 1011, 'Portland',      'locality', 'US'),
  (1020, 1001, 'Vermont',       'region',   'US'),
  (1021, 1020, 'Burlington',    'locality', 'US');

-- ===========================================================================
-- France
-- ===========================================================================

INSERT INTO spr (id, parent_id, name, placetype, country) VALUES
  (2001, -1,   'France',                    'country', 'FR'),
  (2010, 2001, 'Île-de-France',             'region',  'FR'),
  (2011, 2010, 'Paris',                     'locality','FR'),
  (2020, 2001, 'Auvergne-Rhône-Alpes',      'region',  'FR'),
  (2021, 2020, 'Rhône',                     'county',  'FR'),
  (2022, 2021, 'Lyon',                      'locality','FR');

-- Superseded record to verify the adapter filters on is_current.
INSERT INTO spr (id, parent_id, name, placetype, country, is_current) VALUES
  (1099, 1001, 'Old Place', 'locality', 'US', 0);
