-- Hand-crafted Who's On First postalcode fixture (CC0).
--
-- Subset of the real `whosonfirst-data-postalcode-<cc>-latest.spatial.db`
-- schema. Each row is a postalcode placetype whose `parent_id` points at a
-- locality (city) in the admin DB; for fixture purposes we collocate the
-- relevant admin rows in the same table so the adapter only needs one DB
-- per run.

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

-- Admin ancestry needed for postcode rows to resolve.
INSERT INTO spr (id, parent_id, name, placetype, country) VALUES
  (1001, -1,   'United States',     'country',  'US'),
  (1010, 1001, 'Oregon',            'region',   'US'),
  (1012, 1010, 'Portland',          'locality', 'US'),
  (1020, 1001, 'Vermont',           'region',   'US'),
  (1021, 1020, 'Burlington',        'locality', 'US'),
  (2001, -1,   'France',            'country',  'FR'),
  (2010, 2001, 'Île-de-France',     'region',   'FR'),
  (2011, 2010, 'Paris',             'locality', 'FR'),
  (2020, 2001, 'Auvergne-Rhône-Alpes','region', 'FR'),
  (2022, 2020, 'Lyon',              'locality', 'FR');

-- Postal codes per Phase 1's "pairing postcode with its parent locality / region".
-- Each row's parent_id points at a locality.
INSERT INTO spr (id, parent_id, name, placetype, country) VALUES
  (5001, 1012, '97214', 'postalcode', 'US'),
  (5002, 1012, '97215', 'postalcode', 'US'),
  (5003, 1021, '05401', 'postalcode', 'US'),
  (5101, 2011, '75008', 'postalcode', 'FR'),
  (5102, 2011, '75001', 'postalcode', 'FR'),
  (5103, 2022, '69002', 'postalcode', 'FR');

-- A superseded postcode to exercise is_current filter.
INSERT INTO spr (id, parent_id, name, placetype, country, is_current) VALUES
  (5099, 1012, '00000', 'postalcode', 'US', 0);
