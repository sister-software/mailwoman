# @mailwoman/ban

Base Adresse Nationale (France) rooftop ingestion. This package reads the open BAN CSV dumps
(`adresses-<dept>.csv`, adresse.data.gouv.fr) and builds the **national FR address-point database** on the
same situs schema that the US rooftop tier uses. The existing `AddressPointSqliteLookup` reads it without
changes. The resolver gains rooftop precision across France from the authoritative government register
(26M addresses) instead of the sparse community fallback (OSM-FR, ~1.1M points).

This package is the French counterpart of the 50-state US situs layer (#1012). It addresses the measured
FR rooftop gap. Commune resolution was already ~99% @25 km, but @1 km sat at ~37% and stayed _flat_ from
clean to messy input. That flatness indicates a coverage ceiling rather than a parse problem, and BAN
supplies the missing coverage.

## The licensing boundary

The OpenStreetMap tier is ODbL. BAN is published under the **License Ouverte / Open License 2.0
(Etalab)**, which requires attribution only and has **no share-alike** clause. The built database
therefore ships under the same terms as the permissive Mailwoman core (Who's On First, Overture,
OpenAddresses, GeoNames), and it does not require lawyer sign-off. The one standing obligation is
attribution:

- **This package contains code only.** It contains no BAN bytes.
- **Any result resolved through a BAN point carries attribution.** The `source` on every BAN point is
  `ban:fr`, and the resolver should display
  _"© les contributeurs de la Base Adresse Nationale (adresse.data.gouv.fr)"_.

## Building the database

BAN's per-département dumps land under `$MAILWOMAN_DATA_ROOT/…/ban/` (or the corpus source dir). The build
streams them without an external CLI or DuckDB, so it has few dependencies and does not run out of memory
on the 26M-row national set.

```bash
# 1. Download the per-département dumps (or the national adresses-france.csv.gz):
#    https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-<dept>.csv.gz
#    → $MAILWOMAN_DATA_ROOT/db/ban/sources/   (or reuse an existing corpus/sources/ban)

# 2. Build the national extract (writes $MAILWOMAN_DATA_ROOT/db/ban/address-points-fr.db, sealed 0444):
node ban/out/scripts/build-address-point-extract.js \
  --csv-dir $MAILWOMAN_DATA_ROOT/corpus/sources/ban --release 2026-05-18

# Validate on a few départements first (transient; skips the provenance rewrite):
node ban/out/scripts/build-address-point-extract.js --depts 48,2A,05 --out /tmp/ban-sample.db
```

The build records provenance (source URL, license, release, row count, md5) in `ban/ATTRIBUTION.json` at
creation, seals the artifact read-only, and swaps it into place atomically. The database is a new,
additive file, and the build never touches the OSM database beside it.

## The resolution tier

`BANRegionDatabaseProvider.for(country)` is wired into `GeocodeDeps.nationalExtracts`. The resolver
consults it **ahead of** the OSM `osmExtracts` tier, because a national authoritative register outranks
the community fallback, and only for a non-US parse. BAN rows carry their own postcode and commune, so the
lookup keys on the scoped (`postcode` → `locality`) probes and needs no bbox fall-through. Interpolation
for house numbers that BAN does not carry is not built yet. BAN adds the exact-point tier, and its point
density is the reason to use it.
