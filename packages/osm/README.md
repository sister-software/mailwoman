# @mailwoman/osm

OpenStreetMap rooftop ingestion. This package reads a Geofabrik `.osm.pbf` extract and builds a
per-country **address-point database** on the same situs schema the US rooftop tier already uses — so the
existing `AddressPointSqliteLookup` reads it with zero changes, and the resolver gains street/rooftop
precision in countries the permissive gazetteer only covers at the admin level.

It is **address-point-first**: we write the exact `addr:housenumber` coordinate (a node, or a building
polygon's centroid). Interpolation is a separate tier conditioned on confidence, built only from OSM's explicit
`addr:interpolation` ways — we never synthesize a house-number line from scattered points, because that
produces confident wrong answers worse than the admin centroid.

## The licensing boundary

OpenStreetMap data is published under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
(ODbL). This package keeps the code and the data apart.

- **The npm package is code.** It contains no OpenStreetMap data: no extract, database, GeoJSON or test
  fixture. Its `package.json` declares `mailwoman.codeOnly`, and the release audit refuses to publish a
  tarball that ships a data file. ODbL section 2.3(a) excludes the programs used to make or operate a
  database from the license, so the code is under Mailwoman's terms (`AGPL-3.0-only OR LicenseRef-Commercial`).
- **You build the database, and the ODbL applies to it.** Each `address-points-<cc>-<slug>.db` is an
  OpenStreetMap Derivative Database built on your machine from a Geofabrik extract you download.
  Mailwoman publishes no prebuilt OpenStreetMap database.
- **Mailwoman's own gazetteer contains no OpenStreetMap data.** The OpenStreetMap points stay in their own
  per-country databases beside the gazetteer. Every row records `source = openstreetmap:<cc>`, so a result
  that resolved through one carries that source.

### What a built database records and what it asks of you

The builder prints the license notice when it starts and when it finishes. The database's `layer_manifest`
records `ODbL-1.0`, the credit `© OpenStreetMap contributors`, the Geofabrik URL and SHA-256 of the extract
it read, the snapshot date, and the repository commit that built it.

Your own lookups with the database count as internal use. When you publicly use it, or a database derived
from it, the ODbL's terms apply to you as the party using it:

- credit "© OpenStreetMap contributors" with a link to <https://www.openstreetmap.org/copyright> where the
  data is shown, including on a public geocoding service built on it;
- offer the derived database under ODbL (section 4.4), and offer recipients the database or a file that
  reproduces your changes (section 4.6).

The OpenStreetMap Foundation's [Geocoding Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Geocoding_-_Guideline)
treats an individual geocoding result as an insubstantial extract, so storing a result beside your own
records does not by itself place those records under ODbL. Systematically copying OpenStreetMap data into
another database can.

`mailwoman doctor` lists every `address-points-*.db` under `$MAILWOMAN_DATA_ROOT/db/osm` with the license and
credit its manifest records, and `mailwoman data bom` reports each one as its own component. To decline
share-alike data, set `MAILWOMAN_REFUSE_OBLIGATIONS=share-alike`: the geocode session then refuses to start
while an OpenStreetMap database is on disk, and its error repeats the database's recorded provenance.

The customer-facing explanation is the [OpenStreetMap attribution page](https://mailwoman.ai/resources/osm/attribution).

## Build a per-country database

The rooftop table this builder writes, with its H3 spine and layer-interface tables, is declared in
`@mailwoman/resolver-wof-sqlite/address/point/spine-schema` (`createSpineAddressPointTables`), which the
G-NAF builder shares. This package keeps the OpenStreetMap-specific acquisition, extraction and
interpretation. The steps below still run the package's build scripts. A public `mailwoman data build`
command is proposed in [#2868](https://github.com/sister-software/mailwoman/issues/2868) and does not exist yet.

You need GDAL (`ogr2ogr`) on the path — the same dependency `@mailwoman/tiger` uses. GDAL's OSM driver
resolves node and way/polygon geometries for us, so building-tagged addresses (the dominant German shape)
aren't lost.

Install the package beside `mailwoman`, which loads it as an optional peer when it is present:

```bash
npm install mailwoman @mailwoman/osm
OSM="$(npm root)/@mailwoman/osm/out/tools"

# 1. Download a Geofabrik extract. The tool dates the file name from the server's Last-Modified header and
#    writes <file>.receipt.json beside it with the URL, the date and the SHA-256:
node "$OSM/fetch/extract.js" --region australia-oceania/new-zealand
#    → $MAILWOMAN_DATA_ROOT/db/osm/geofabrik/new-zealand-260806.osm.pbf (+ .receipt.json)

# 2. Build the database. The default slug is the country code, which is the file name the geocode
#    session attaches (writes $MAILWOMAN_DATA_ROOT/db/osm/address-points-nz-nz.db):
node "$OSM/build-rooftop-database.js" \
  --country nz --release 260806 \
  --created-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --build-sha "@mailwoman/osm@$(node -p 'require(process.argv[1]).version' "$(npm root)/@mailwoman/osm/package.json")" \
  --pbf $MAILWOMAN_DATA_ROOT/db/osm/geofabrik/new-zealand-260806.osm.pbf
```

From a checkout of this repository, run the same tools from `packages/osm/out/tools/` and pass
`--build-sha "$(git rev-parse HEAD)"`. An extract downloaded by hand has no receipt, and the builder then
requires `--source-url` with the address it came from.

The build reports an **association gap**: the share of `addr:housenumber` points it had to skip because
they have no `addr:street`. A point with no street is unqueryable, so we count it rather than guess. When
that gap is large for a country, the fix is a street-association recovery pass that tries `associatedStreet` relations,
then the enclosing polygon's `addr:street`, then point-in-polygon. The pass is sized to the measured gap
rather than built before a measurement.

Supported countries are a deliberately small set (currently DE, FR, GB, NL, and NZ, listed in
`streetLocaleForCountry`). Each needs a matching
branch in the locale street normalizer, so adding one is two edits in lockstep, never a silent fold with
the wrong rules.

### Clip the extract to its own country

A Geofabrik country extract carries a margin past the border, so its address records include every land
neighbor's border towns, and the `osm` adapter stamps every row with the `--country` value.
`addr:country` is set on too few records to filter on. Fetch ADM0 outlines from geoBoundaries with
`node packages/osm/tools/fetch/country-outline.ts --iso3 <code>`, which writes a receipt beside each
outline, and emit the corpus with `emit-corpus-jsonl --within <own outline> --without <each land neighbor's outline>`.
A detailed neighbor outline excludes the border towns that a coarse own outline misplaces.
geoBoundaries has no HKG or MAC entry. The CHN outline already excludes both.

For the address scope key, an observed `addr:suburb` outranks `addr:city`. This matters in NZ and GB,
where queries commonly name the suburb while `addr:city` names the wider metropolitan authority. City-only
queries still reach the same row through the resolved locality bbox fallback.

## Interface migration requirements

The builder extends the shared legacy `address_point` table so the existing lookup can consume a locally
built database immediately. Every OSM row also stores a res-9 H3 spine, and the database embeds `layer_manifest`
and `layer_coverage`. It builds on a temporary file, swaps atomically, and seals the result read-only.

The coverage table initially remains empty by design. OSM is an incomplete survey, and a Geofabrik
extract’s geographic extent proves only that a cell was included in the download—not that its addresses are
complete. Until a separately validated completeness estimator populates the table, every coverage probe
returns unknown and OSM absence cannot power negative evidence. Recovery-derived street associations also
remain distinguishable from observed `addr:street` values in provenance and evaluation: the coordinate may
be an observed building while its query key is inferred.

## Benchmark-directed build order

The repaired 420-row Mailwoman/Pelias/Photon panel shows that coverage should be acquired before tuning the parser:

1. **New Zealand** is the largest address-atlas gap (Mailwoman 3/60 versus Photon 60/60 at 1 km).
2. **Great Britain and Germany** are next (20/60 versus 51/60, and 19/60 versus 55/60).
3. **Australia** should use the sanctioned OpenAddresses countrywide feed first. After the WA country-scope
   repair, its remaining misses are predominantly absent rooftop data rather than resolver leakage.
4. **France is not the first OSM target.** BAN already gives Mailwoman 47/60 at 1 km versus Photon’s 38/60.

These comparisons set the investigation order. They are not promises that every Photon hit came from an OSM
rooftop. Each country still needs a source-composition census and a held-out precision measurement before a full build.

The first local NZ build (Geofabrik source vintage 2026-08-06) contains 2,325,228 directly tagged address
points. Only 548 housenumber features lacked a usable street. On the repaired panel, through the production
`OSMRegionDatabaseProvider` path, it moved Mailwoman from 3/20/30 to 56/58/59 at 1/5/25 km, produced 56
`address_point` results, eliminated all 17 no-results, and caused no regression. Photon remains stronger at
1 km (60/60); Mailwoman with the locally built database exceeds the frozen Pelias NZ arm (45/45/46). This is a
build-local result rather than a shipped-data claim.
