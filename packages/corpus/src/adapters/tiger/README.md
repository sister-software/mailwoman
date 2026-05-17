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

### Recommended ingest: `ogr2ogr`

The GDAL command-line tool ships in every major Linux distribution. The
ingest has two important wrinkles the operator should know before running:

1. **ADDRFEAT is published per-COUNTY, not per-state.** Filename pattern is
   `tl_2024_<5-digit-FIPS>_addrfeat.zip` where the 5-digit FIPS is the
   2-digit state FIPS concatenated with the 3-digit county FIPS. A single
   state can ship anywhere from ~3 county zips (DC) to ~250 (Texas). PLACE
   _is_ per-state (`tl_2024_<state-fips>_place.zip`).
2. **`STATEFP` is NOT a column in ADDRFEAT shapefiles.** It's present in
   PLACE but not ADDRFEAT. The mailwoman adapter expects `tiger_streets`
   to have a `statefp` column, so it must be derived at ingest time. The
   `LINEARID` first-2-chars trick does NOT work — LINEARID's structure
   doesn't carry state FIPS in its prefix; every TIGER LINEARID starts
   with the same prefix bytes. Derive it from the filename instead.

Here's a complete ingest loop for one state's worth of data:

```sh
# Download:
#   Per-county ADDRFEAT: https://www2.census.gov/geo/tiger/TIGER2024/ADDRFEAT/
#   Per-state PLACE:     https://www2.census.gov/geo/tiger/TIGER2024/PLACE/

# Extract all the zips into a flat dir (extracted/), then:

STATE_FIPS=50   # Vermont, for example

# Initialize tiger_streets from the first county's ADDRFEAT.
FIRST=$(ls extracted/tl_2024_${STATE_FIPS}???_addrfeat.shp | head -1)
LAYER=$(basename "$FIRST" .shp)
ogr2ogr -f SQLite tiger.db \
    -nln tiger_streets \
    -dialect SQLite \
    -sql "SELECT LINEARID, FULLNAME, ZIPL, ZIPR, '${STATE_FIPS}' AS STATEFP
          FROM '${LAYER}' WHERE FULLNAME IS NOT NULL" \
    "$FIRST"

# Append every subsequent county's ADDRFEAT into the same table.
for shp in extracted/tl_2024_${STATE_FIPS}???_addrfeat.shp; do
    [ "$shp" = "$FIRST" ] && continue
    LAYER=$(basename "$shp" .shp)
    ogr2ogr -update -append tiger.db -nln tiger_streets \
        -dialect SQLite \
        -sql "SELECT LINEARID, FULLNAME, ZIPL, ZIPR, '${STATE_FIPS}' AS STATEFP
              FROM '${LAYER}' WHERE FULLNAME IS NOT NULL" \
        "$shp"
done

# PLACE has STATEFP natively + is per-state, so it's one call.
ogr2ogr -update -append tiger.db \
    -nln tiger_places \
    -select GEOID,NAME,STATEFP,LSAD \
    extracted/tl_2024_${STATE_FIPS}_place.shp

# Repeat the whole block per state with a different STATE_FIPS.
```

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
