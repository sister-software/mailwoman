# @mailwoman/osm

OpenStreetMap rooftop ingestion. This package reads a Geofabrik `.osm.pbf` extract and builds a
per-country **address-point database** on the same situs schema the US rooftop tier already uses — so the
existing `AddressPointSqliteLookup` reads it with zero changes, and the resolver gains street/rooftop
precision in countries the permissive gazetteer only covers at the admin level.

It is **address-point-first**: we write the exact `addr:housenumber` coordinate (a node, or a building
polygon's centroid). Interpolation is a separate tier conditioned on confidence, built only from OSM's explicit
`addr:interpolation` ways — we never synthesise a house-number line from scattered points, because that
produces confident wrong answers worse than the admin centroid.

## The licensing boundary — read this first

OpenStreetMap data is licensed under the **ODbL**, which is share-alike on a Derived Database. Mailwoman's
core gazetteer is built from permissive sources (Who's On First, Overture, OpenAddresses, GeoNames) and we
keep it that way. So the OSM precision tier is quarantined:

- **This package is code, and code only.** It contains no OSM bytes. You can depend on it, read it, and
  ship it under the same terms as the rest of Mailwoman.
- **The ODbL obligation rides on the built database.** Each `address-points-<cc>-<slug>.db` this package
  produces is an OSM Derived Database. It is a separately-distributed, opt-in data artifact — you download
  the countries you want, and you take the share-alike obligation only on those.
- **The permissive core never touches an OSM byte.** OSM points are not folded into the WOF-keyed
  gazetteer; they live in their own per-country databases beside it. The `source` on every OSM point is
  `openstreetmap:<cc>`, so attribution and license are attributable per-row, and the resolver surfaces
  "© OpenStreetMap contributors (ODbL)" on any result that resolved through one.

### ⚠ Lawyer sign-off required

No OSM database ships to npm, R2, or the public demo until counsel has reviewed how ODbL share-alike applies
to our distribution model (the opt-in-per-country database, the attribution surface, and whether serving a
resolved coordinate from one constitutes a Produced Work or a Derived Database hand-off). The build and the
local benchmark below are fine to run now; **publishing is blocked on that review.**

The full boundary doc (the per-source license matrix, the attribution requirements, and the counsel sign-off
requirement) is [`docs/articles/licensing/data-provenance.md`](../docs/articles/licensing/data-provenance.md); this
section is the package-local summary.

## Building a per-country database

You need GDAL (`ogr2ogr`) on the path — the same dependency `@mailwoman/tiger` uses. GDAL's OSM driver
resolves node and way/polygon geometries for us, so building-tagged addresses (the dominant German shape)
aren't lost.

```bash
# 1. Pull a Geofabrik extract (per-country, or a sub-region to smoke a build):
#    https://download.geofabrik.de/europe/france/ile-de-france-latest.osm.pbf
#    → $MAILWOMAN_DATA_ROOT/osm/geofabrik/

# 2. Build the extract (writes $MAILWOMAN_DATA_ROOT/osm/address-points-fr-idf.db):
node osm/out/scripts/build-rooftop-extract.js \
  --country fr --slug idf --release 260627 \
  --created-at 2026-06-27T00:00:00.000Z \
  --build-sha "$(git rev-parse HEAD)" \
  --pbf $MAILWOMAN_DATA_ROOT/osm/geofabrik/ile-de-france-260627.osm.pbf
```

The build reports an **association gap** — the share of `addr:housenumber` points it had to skip because
they carry no `addr:street`. A point with no street is unqueryable, so we count it rather than guess. When
that gap is large for a country, the fix is a street-association recovery pass (`associatedStreet` relations
→ enclosing-polygon `addr:street` → point-in-polygon), sized to the measured gap — not built blind.

Supported countries are a deliberately small set (currently DE, FR, GB, NL, and NZ; see
`streetLocaleForCountry`): each needs a matching
branch in the locale street normalizer, so adding one is two edits in lockstep, never a silent fold with
the wrong rules.

For the address scope key, an observed `addr:suburb` outranks `addr:city`. This matters in NZ and GB,
where queries commonly name the suburb while `addr:city` names the wider metropolitan authority. City-only
queries still reach the same row through the resolved locality bbox fallback.

## Contract migration requirements

The builder extends the shared legacy `address_point` table so the existing lookup can consume a locally
built database immediately. Every OSM row also carries a res-9 H3 spine, and the database embeds `layer_manifest`
and `layer_coverage`. It builds on a temporary file, swaps atomically, and seals the result read-only.

The coverage table initially remains empty by design. OSM is an incomplete survey, and a Geofabrik
extract’s geographic extent proves only that a cell was included in the download—not that its addresses are
complete. Until a separately validated completeness estimator populates the table, every coverage probe
returns unknown and OSM absence cannot power negative evidence. Recovery-derived street associations also
remain distinguishable from observed `addr:street` values in provenance and evaluation: the coordinate may
be an observed building while its query key is inferred.

## Benchmark-directed build order

The repaired 420-row Mailwoman/Pelias/Photon panel says to acquire coverage before tuning the parser:

1. **New Zealand** is the largest address-atlas gap (Mailwoman 3/60 versus Photon 60/60 at 1 km).
2. **Great Britain and Germany** are next (20/60 versus 51/60, and 19/60 versus 55/60).
3. **Australia** should use the sanctioned OpenAddresses countrywide feed first; after the WA country-scope
   repair, its remaining misses are predominantly absent rooftop data rather than resolver leakage.
4. **France is not the first OSM target.** BAN already gives Mailwoman 47/60 at 1 km versus Photon’s 38/60.

These comparisons prioritize investigation; they are not promises that every Photon hit came from an OSM
rooftop. Each country still needs a source-composition census and a held-out precision measurement before a full build.

The first local NZ build (Geofabrik source vintage 2026-08-06) contains 2,325,228 directly tagged address
points; only 548 housenumber features lacked a usable street. On the repaired panel, through the production
`OSMRegionDatabaseProvider` path, it moved Mailwoman from 3/20/30 to 56/58/59 at 1/5/25 km, produced 56
`address_point` results, eliminated all 17 no-results, and caused no regression. Photon remains stronger at
1 km (60/60); Mailwoman with the locally built database exceeds the frozen Pelias NZ arm (45/45/46). This is a
build-local result, not a shipped-data claim.
