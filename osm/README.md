# @mailwoman/osm

OpenStreetMap rooftop ingestion. This package reads a Geofabrik `.osm.pbf` extract and builds a
per-country **address-point shard** on the same situs schema the US rooftop tier already uses — so the
existing `AddressPointSqliteLookup` reads it with zero changes, and the resolver gains street/rooftop
precision in countries the permissive gazetteer only covers at the admin level.

It is **address-point-first**: we write the exact `addr:housenumber` coordinate (a node, or a building
polygon's centroid). Interpolation is a separate, confidence-gated tier built only from OSM's explicit
`addr:interpolation` ways — we never synthesise a house-number line from scattered points, because that
produces confident wrong answers worse than the admin centroid.

## The licensing boundary — read this first

OpenStreetMap data is licensed under the **ODbL**, which is share-alike on a Derived Database. Mailwoman's
core gazetteer is built from permissive sources (Who's On First, Overture, OpenAddresses, GeoNames) and we
keep it that way. So the OSM precision tier is quarantined:

- **This package is code, and code only.** It contains no OSM bytes. You can depend on it, read it, and
  ship it under the same terms as the rest of Mailwoman.
- **The ODbL obligation rides on the built shard.** Each `address-points-<cc>-<slug>.db` this package
  produces is an OSM Derived Database. It is a separately-distributed, opt-in data artifact — you download
  the countries you want, and you take the share-alike obligation only on those.
- **The permissive core never touches an OSM byte.** OSM points are not folded into the WOF-keyed
  gazetteer; they live in their own shards beside it. The `source` on every OSM point is
  `openstreetmap:<cc>`, so attribution and licence are attributable per-row, and the resolver surfaces
  "© OpenStreetMap contributors (ODbL)" on any result that resolved through one.

### ⚠ Lawyer sign-off gate

No OSM shard ships to npm, R2, or the public demo until counsel has reviewed how ODbL share-alike applies
to our distribution model (the opt-in-per-country shard, the attribution surface, and whether serving a
resolved coordinate from one constitutes a Produced Work or a Derived Database hand-off). The build and the
local benchmark below are fine to run now; **publishing is blocked on that review.**

The full boundary doc (the per-source license matrix, the attribution requirements, and the counsel sign-off
gate) is [`docs/articles/licensing/data-provenance.md`](../docs/articles/licensing/data-provenance.md); this
section is the package-local summary.

## Building a shard

You need GDAL (`ogr2ogr`) on the path — the same dependency `@mailwoman/tiger` uses. GDAL's OSM driver
resolves node and way/polygon geometries for us, so building-tagged addresses (the dominant German shape)
aren't lost.

```bash
# 1. Pull a Geofabrik extract (per-country, or a sub-region to smoke a build):
#    https://download.geofabrik.de/europe/france/ile-de-france-latest.osm.pbf
#    → $MAILWOMAN_DATA_ROOT/osm/geofabrik/

# 2. Build the shard (writes $MAILWOMAN_DATA_ROOT/osm/address-points-fr-idf.db):
node osm/out/scripts/build-rooftop-shard.js \
  --country fr --slug idf --release 260627 \
  --pbf $MAILWOMAN_DATA_ROOT/osm/geofabrik/ile-de-france-260627.osm.pbf
```

The build reports an **association gap** — the share of `addr:housenumber` points it had to skip because
they carry no `addr:street`. A point with no street is unqueryable, so we count it rather than guess. When
that gap is large for a country, the fix is a street-association recovery pass (`associatedStreet` relations
→ enclosing-polygon `addr:street` → point-in-polygon), sized to the measured gap — not built blind.

Supported countries are a deliberately small set (see `streetLocaleForCountry`): each needs a matching
branch in the locale street normalizer, so adding one is two edits in lockstep, never a silent fold with
the wrong rules.
