# @mailwoman/ban

Base Adresse Nationale (France) rooftop ingestion. This package reads the open BAN CSV dumps
(`adresses-<dept>.csv`, adresse.data.gouv.fr) and builds the **national FR address-point shard** on the
same situs schema the US rooftop tier already uses — so the existing `AddressPointSqliteLookup` reads it
with zero changes, and the resolver gains rooftop precision across France from the authoritative
government register (26M addresses) instead of the sparse community fallback (OSM-FR, ~1.1M points).

It is the French counterpart of the 50-state US situs layer (#1012). It closes the measured FR rooftop
gap: commune resolution was already ~99% @25 km, but @1 km sat at ~37% and was _flat_ from clean to messy
input — the flatness is the tell of a coverage ceiling, not a parse problem. BAN is the coverage.

## The licensing boundary

Unlike the ODbL OpenStreetMap tier, BAN is published under the **Licence Ouverte / Open Licence 2.0
(Etalab)** — attribution only, **no share-alike**. So the built shard ships under the same terms as the
permissive Mailwoman core (Who's On First, Overture, OpenAddresses, GeoNames); there is no lawyer sign-off
gate. The one standing obligation is attribution:

- **This package is code, and code only.** It contains no BAN bytes.
- **Attribution rides on any result resolved through a BAN point.** The `source` on every BAN point is
  `ban:fr`, and the resolver should surface
  _"© les contributeurs de la Base Adresse Nationale (adresse.data.gouv.fr)"_.

## Building the shard

BAN's per-département dumps land under `$MAILWOMAN_DATA_ROOT/…/ban/` (or the corpus source dir). The build
streams them — no external CLI, no DuckDB — so it is dependency-light and OOM-safe on the 26M-row national
set.

```bash
# 1. Download the per-département dumps (or the national adresses-france.csv.gz):
#    https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-<dept>.csv.gz
#    → $MAILWOMAN_DATA_ROOT/ban/sources/   (or reuse an existing corpus/sources/ban)

# 2. Build the national shard (writes $MAILWOMAN_DATA_ROOT/ban/address-points-fr.db, sealed 0444):
node ban/out/scripts/build-address-point-shard.js \
  --csv-dir $MAILWOMAN_DATA_ROOT/corpus/sources/ban --release 2026-05-18

# Validate on a few départements first (transient; skips the provenance rewrite):
node ban/out/scripts/build-address-point-shard.js --depts 48,2A,05 --out /tmp/ban-sample.db
```

The build records provenance (source URL, license, release, row count, md5) in `ban/ATTRIBUTION.json` at
creation, seals the artifact read-only, and swaps it into place atomically — it is a new, purely-additive
file and never touches the OSM shard beside it.

## The resolution tier

`BANShardProvider.for(country)` is wired into `GeocodeDeps.nationalShards`, consulted **ahead of** the OSM
`osmShards` tier (a national authoritative register outranks the community fallback) and only for a non-US
parse. BAN rows carry their own postcode + commune, so the lookup keys on the scoped
(`postcode` → `locality`) probes; no bbox fall-through is needed. Interpolation for house numbers BAN
doesn't carry is not built yet — the exact-point tier is the whole win here (BAN's density is the point).
