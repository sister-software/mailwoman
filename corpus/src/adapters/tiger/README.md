# `tiger` adapter

US Census TIGER/Line consumer — streets + places, public domain, US-only.

## Why TIGER?

TIGER/Line is the canonical US street + locality dataset. Three reasons
mailwoman uses it alongside (or in place of) OpenAddresses + OSM for
US coverage:

1. **Public domain**: no ODbL share-alike obligations for US-only
   corpora. Compatible with every downstream training license model.
2. **Coverage**: every named street segment + every incorporated place
   and CDP across the 50 states, DC, and territories. Better rural
   coverage than OSM, especially for the rural Mountain West and Alaska.
3. **Canonical naming**: street names match the USPS Pub-28 canonical
   form (the postal service is the same federal government as the
   Census), so the suffix-codex augmentations (`us-street-suffix-*` in
   `synthesize.ts`) compose cleanly.

## Input

A SQLite database the operator pre-builds from the raw TIGER/Line
shapefiles. The mailwoman side does **not** parse Shapefile binary
directly — the ecosystem has mature tools for that and forcing one as a
mailwoman dep would be opinionated. Pick whichever fits your pipeline.

### Recommended ingest: `mailwoman tiger fetch`

Build `tiger.db` with the CLI. It downloads, extracts, and loads `tiger_streets`
+ `tiger_places` in exactly the schema this adapter reads, and handles the two
wrinkles by itself:

1. **ADDRFEAT is published per-COUNTY** (`tl_2024_<5-digit-FIPS>_addrfeat.zip`,
   ~3 county zips for DC to ~250 for Texas), so the CLI discovers a state's
   counties from the Census directory listing and fans out. PLACE is per-state.
2. **`STATEFP` is not an ADDRFEAT column** (it's in PLACE but not ADDRFEAT), so
   the CLI injects `statefp` from the state being fetched.

```sh
# place is per-state; addrfeat fans out over the state's counties.
mailwoman tiger fetch --state 50 --level place    --out tiger.db   # Vermont
mailwoman tiger fetch --state 50 --level addrfeat --out tiger.db

# Repeat per state. Re-running a state replaces its rows (idempotent).
```

(Internally the CLI still shells out to `ogr2ogr` for the shapefile read +
column mapping; it just owns the discovery, schema, and idempotency.)

The `WHERE FULLNAME IS NOT NULL` filter drops the small fraction of segment
rows that have no name (typically unnamed alleys or parcel edges) — they
contribute no signal to a street-name training corpus.

The PLACE column names match TIGER's canonical names (just lowercased —
SQLite's identifier folding handles that). For ADDRFEAT the SQL extract
above renames the literal `STATE_FIPS` shell variable into a `STATEFP`
column, producing the column the adapter expects.

## Expected schema

```sql
CREATE TABLE tiger_streets (
  linearid TEXT PRIMARY KEY,    -- TIGER LINEARID (segment id)
  fullname TEXT NOT NULL,       -- e.g. "S Main St"
  zipl     TEXT,                -- Left-side 5-digit ZIP
  zipr     TEXT,                -- Right-side 5-digit ZIP
  statefp  TEXT NOT NULL        -- 2-digit state FIPS code
);

CREATE TABLE tiger_places (
  geoid    TEXT PRIMARY KEY,    -- 7-char state_FIPS + place_FIPS
  name     TEXT NOT NULL,       -- "Burlington"
  statefp  TEXT NOT NULL,       -- "50"
  lsad     TEXT                 -- Legal/Statistical Area Description
);
```

`lsad` is read but currently ignored — it differentiates city / town /
CDP / borough / consolidated municipality. A future enhancement could
emit a `place_type` component if that signal proves useful in training.

## Output

Two row classes per source row:

### Street-level

One or two rows per `tiger_streets` segment, depending on ZIPs:

| Condition        | Rows emitted                          |
| ---------------- | ------------------------------------- |
| Both ZIPs absent | 1 row: `{ street, region }`           |
| `zipl === zipr`  | 1 row: `{ street, region, postcode }` |
| `zipl !== zipr`  | 2 rows, one per side's postcode       |

`source_id` shape: `tiger-st-<linearid>-<variant-key>`, where
`<variant-key>` is `no-zip`, `zip-<NNNNN>`, `zipl-<NNNNN>`, or
`zipr-<NNNNN>`.

### Locality-level

Three variants per `tiger_places` row (mirrors `wof-admin`'s fan-out
for consistency):

1. `{ locality }` only
2. `{ locality, region }`
3. `{ locality, region, country: "United States of America" }`

`source_id` shape: `tiger-pl-<geoid>-<variant-key>` where
`<variant-key>` ∈ `locality-only` / `with-region` / `with-region-country`.

## License

Every emitted row carries `license: "Public Domain"` per the Census
Bureau's TIGER/Line terms. There is no per-row override — TIGER is
single-license throughout.

## Country filter

`--country US` is allowed (and is a no-op since the adapter is US-only).
Any other country value is rejected with a clear error.

## Known limitations

- The adapter does **not** join streets to places (TIGER ADDRFEAT does
  not carry a place_id directly — joining requires the FACES + EDGES
  cross-reference, which is heavy). Street rows therefore lack a
  `locality` component. The model still learns `street + region`
  patterns which dominate US-style addressing; place-level signal
  arrives separately via the locality variants.
- House-number ranges on `tiger_streets` are not consulted for synthetic
  house numbers. Generating realistic synthetic house numbers from the
  TIGER range columns (`LFROMADD` / `LTOADD` / `RFROMADD` / `RTOADD`) is
  scoped as a follow-up — for Phase 1.5 the adapter intentionally stays
  on the canonical-row contract without house-number synthesis.

## Fixture

`fixtures/tiger/fixture.sql` — 7 hand-crafted street segments + 4
places across Oregon, Vermont, Wyoming (held out for val/test under
the default split policy), and California. All public-knowledge place
names; LINEARID + GEOID values are illustrative, not real TIGER
records.
