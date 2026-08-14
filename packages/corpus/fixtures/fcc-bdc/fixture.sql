-- Hand-crafted FCC BDC fixture for the @mailwoman/corpus fcc-bdc adapter.
--
-- License: the BDC fabric distribution is published by the FCC under
-- public-domain terms. Every entry below uses public-knowledge place
-- names and illustrative location_id values; none match a real BSL ID.
--
-- The mailwoman fcc-bdc adapter expects one table the operator builds
-- from the isp-nexus BDC ETL (or any equivalent host-side script):
--   bdc_locations  ← NTIARecord, one row per BSL location_id
-- Column names match the NTIARecord field names (see
-- /srv/isp-nexus/fcc/bdc/data-collection.ts) so a CSV `.import` from the
-- raw NTIA distribution lands in the right shape without per-column
-- renames.

CREATE TABLE bdc_locations (
  location_id    INTEGER PRIMARY KEY,   -- Stable BSL fabric ID (persistent across vintages)
  address_primary TEXT NOT NULL,        -- "123 Main St" — postal address sans city/state/zip
  city           TEXT NOT NULL,         -- "Portland"
  state          TEXT NOT NULL,         -- 2-char USPS abbreviation
  zip            TEXT NOT NULL,         -- 5-digit ZIP
  zip_suffix     TEXT                   -- Optional 4-digit ZIP+4 extension
);

CREATE INDEX bdc_locations_state ON bdc_locations (state);

-- ===========================================================================
-- Canonical fabric rows across diverse US states + suffix combinations
-- ===========================================================================

INSERT INTO bdc_locations (location_id, address_primary, city, state, zip, zip_suffix) VALUES
  -- Standard urban address, no ZIP+4
  (1000000001, '123 Main St',         'Portland',        'OR', '97215', NULL),
  -- Urban address with ZIP+4 (bare 4-digit extension)
  (1000000002, '456 SE Salmon St',    'Portland',        'OR', '97214', '1234'),
  -- Already-joined ZIP+4 in the suffix column (operator data drift)
  (1000000003, '789 NE Alberta St',   'Portland',        'OR', '97211', '97211-5678'),
  -- Vermont (held-out region under default split policy)
  (1000000010, '50 Church St',        'Burlington',      'VT', '05401', NULL),
  -- House number with trailing letter
  (1000000011, '101A Main St',        'Burlington',      'VT', '05401', '0042'),
  -- Hyphenated house number (NYC garden-apartment style)
  (1000000020, '40-12 Bell Blvd',     'Bayside',         'NY', '11361', NULL),
  -- Wyoming (held-out region)
  (1000000030, '2300 Capitol Ave',    'Cheyenne',        'WY', '82001', NULL),
  -- Address with directional prefix
  (1000000040, '6450 W Indian School Rd', 'Phoenix',     'AZ', '85033', '2100'),
  -- PO Box (no leading digit — should fall back to street-only)
  (1000000050, 'PO Box 1234',         'Anchorage',       'AK', '99503', NULL),
  -- Rural route (no leading digit on the conventional shape)
  (1000000051, 'RR 2 Box 67',         'Lone Tree',       'IA', '52755', NULL),
  -- Territory: Puerto Rico (still in the FIPS table)
  (1000000060, '500 Calle Loiza',     'San Juan',        'PR', '00911', NULL),
  -- Unrecognized state code (should be dropped by the adapter)
  (1000000099, '1 Phantom Way',       'Nowhere',         'ZZ', '00000', NULL);
