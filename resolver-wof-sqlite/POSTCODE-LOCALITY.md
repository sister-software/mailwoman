# `postcode-locality-intl.db` — the coordinate-first candidate asset

A self-contained, read-only SQLite asset mapping **postcode → containing + nearby WOF locality
candidates**, consumed by `WofSqlitePlaceLookup`'s coordinate-first path (`findPlace` with a sibling
`postcode`). It supplies the COORDINATE candidate the FTS name-match can't generate for an
under-indexed small town — see [`docs/articles/plan/2026-06-04-coordinate-first-resolver.md`](../docs/articles/plan/2026-06-04-coordinate-first-resolver.md).

It's built like our other WOF tables: **from source GeoJSON, never a prebuilt dump**, and frozen into
a distributable artifact (a `meta` provenance/license table, `journal_mode=DELETE` so there's no
`-wal`/`-shm` sidecar, `ANALYZE`, an integrity check, and `VACUUM`). You can hand the single `.db` to
anyone and attach it as a resolver shard.

## Schema

```sql
postcode_locality(
  postcode TEXT, country TEXT,           -- key (indexed: postcode_locality_by_pc)
  locality_id INTEGER, locality_name TEXT, aliases TEXT,  -- WOF locality + alt-name aliases (|-joined)
  distance_km REAL, is_containing INTEGER -- 0km/1 = the postcode centroid is inside this locality's polygon
)
meta(key TEXT, value TEXT)               -- name/source/license/attribution/built_at/countries
```

The resolver attaches a **single** `postcode_locality` shard and country-filters at query time, so all
locales live in one DB.

## Build recipe (per locale, then finalize)

`scripts/build-postcode-locality.py` point-in-polygons each postcode centroid against the WOF locality
polygons (+ a ~10km nearby candidate set), accumulating per country into one DB (idempotent:
re-running a country replaces just its rows). It needs the country's `whosonfirst-data-admin-<cc>`
GeoJSON repo (locality polygons) and a postcode SQLite (centroids).

```bash
# one per country into the shared asset
python3 scripts/build-postcode-locality.py --country DE \
  --admin-repo   .../whosonfirst-data/whosonfirst-data-admin-de \
  --postcode-db  .../postalcode-intl.db \
  --output       .../postcode-locality-intl.db

# GB: postcodes aren't in postalcode-intl.db — build a GB postcode DB from source first
node --experimental-strip-types scripts/build-unified-wof.ts \
  --data .../whosonfirst-data-postalcode-gb --output .../postalcode-gb.db --placetypes postalcode
python3 scripts/build-postcode-locality.py --country GB \
  --admin-repo .../whosonfirst-data-admin-gb --postcode-db .../postalcode-gb.db \
  --output .../postcode-locality-intl.db

# freeze into the read-only distributable asset (meta + VACUUM + integrity)
python3 scripts/build-postcode-locality.py --output .../postcode-locality-intl.db --finalize
```

## Coverage (built 2026-06-04)

| country | rows | postcodes with a containing locality | notes |
|---|--:|--:|---|
| DE | 92,689 | 24,443 | resolver PIP-containment **92.6%** (Berlin+Saxony OA sample) |
| FR | 121,628 | 24,455 | resolver PIP-containment **84.0%** (national BAN OA sample; lower than DE because the national set includes the rural commune tail where WOF locality coverage thins) |
| NL | 1,842,253 | 370,222 (99.6%) | resolver PIP-containment **94.9%** (national BAG OA sample) — excellent even though the model is OOD on Dutch, because coordinate-first leans on the regex-extractable postcode + NL's near-complete coverage |
| GB | 7,630,560 | 1,626,691 | unit postcodes; **~34% of GB postcodes get no candidate** (WOF GB locality coverage is incomplete) |
| ES | 27,111 | 3,273 (28.9%) | WOF orphan-heavy — sparse; inert until ES localities are in the admin DB |
| IT | 18,349 | 2,081 (42.2%) | WOF orphan-heavy — sparse; inert until IT localities are in the admin DB |

## Caveats / follow-ups

- **The locality must also be in the resolver's admin DB to resolve.** The table can reference a WOF
  locality id that `admin-global-priority.db` doesn't ship (the admin build globs a different set). DE/FR/GB
  localities are in the admin DB; **ES/IT/NL are not yet** — their tables are built but inert until the
  admin DB is rebuilt to include them. The conflict-flag anchor already tolerates this (it anchors to the
  best candidate that actually resolved).
- **GB locality coverage is ~66%** of unit postcodes. The missing third (e.g. `EH1 1AA`) can't get a
  coordinate candidate or a conflict flag. A finer-grained or non-WOF GB locality source would close it.
- **License:** the data is WOF-derived (CC-BY 4.0; attribution in `meta`). Underlying WOF sources (e.g.
  GeoNames) carry their own attribution — confirm the exact redistribution terms before publishing.
