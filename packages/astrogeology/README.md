# @mailwoman/astrogeology

The planetary data pipeline behind `moon.mailwoman.ai` and `mars.mailwoman.ai`. It turns two USGS Astrogeology products, the planetary nomenclature gazetteer and the LOLA and MOLA global elevation models, into the artifacts the planetary app serves for each body: a nomenclature PMTiles archive, a hillshade PMTiles archive, a search artifact and a build manifest with checksums.

Private: this workspace never publishes to npm. Its artifacts are published to the tile worker's bucket and the public bucket through the same `publishTiles` and `uploadToBucket` functions `mailwoman tiles publish` calls.

Spec: `docs/superpowers/specs/2026-09-06-astrogeology-pipeline-design.md`. Plan: `docs/superpowers/plans/2026-09-07-astrogeology-pipeline.md`.

## Sources

| Source                                 | URL                                                                                           | Bytes         | Pinned by | Notes                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| Moon nomenclature (center points, SHP) | `https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip` | 23,842,450    | snapshot  | 9,086 points; longitude 0..360; `GCS_Moon_2000` (sphere, 1,737,400 m); control network LOLA 2011; public domain |
| Mars nomenclature (center points, SHP) | `https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip` | 5,413,387     | snapshot  | 2,052 points; longitude 0..360; `GCS_Mars_2000` (ellipsoid, 3,396,190 m, 1/f 169.894); MDIM 2.1; public domain  |
| LOLA global DEM, 118 m                 | `https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif`           | 8,494,203,833 | product   | GeoTIFF; the host redirects once and delivers about 4 MB/s to the lab                                           |
| MOLA global DEM, 463 m                 | `https://planetarymaps.usgs.gov/mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif`              | 2,125,771,142 | product   | GeoTIFF                                                                                                         |

The nomenclature archives are regenerated nightly by USGS, so they are pinned by **snapshot**: `astrogeology fetch` downloads the day's archive to `source/<id>-<YYYY-MM-DD>.zip`, records its bytes and SHA-256 in `sources.lock.json`, and every build reads only the locked snapshot. The DEMs are stable products pinned by **URL and byte count**; the first fetch records the SHA-256 and every later fetch refuses a change. A cached file whose size differs from the lock, a product whose size differs from this table, or a re-fetch whose hash differs from the lock all fail naming both values.

The typed table is `lib/sdk/sources.ts`; the lock is `sources.lock.json`, committed, written only by `fetch`.

## Commands

```sh
astrogeology fetch   --body <moon|mars> [--kind nomenclature|dem]
astrogeology build   --body <moon|mars> [--max-zoom 6] [--out <dir>]
astrogeology verify  --body <moon|mars> [--out <dir>]
astrogeology publish --body <moon|mars> [--out <dir>] [--dry-run]
```

- `fetch` pins a body's sources (both kinds when `--kind` is omitted). A source already pinned and on disk is reused.
- `build` runs the whole chain over the locked sources and refuses when the lock lacks one: rows out of the shapefile through `ogr2ogr`, features through normalization, NDJSON with a per-feature minimum zoom by diameter, `tippecanoe`; the DEM through `gdaldem hillshade` in the body's meters per degree, an EPSG:4326 label so GDAL tiles it on the XYZ grid, MBTiles with overviews, `pmtiles convert`; the `mailwoman:*` metadata block into each archive; the search artifact; the manifest.
- `verify` re-reads the manifest, recomputes every output's SHA-256 and size, reads each archive's metadata block back, and refuses on any difference.
- `publish` verifies, then uploads the two archives under the tile worker's keys (`tiles/<body>.pmtiles`, `tiles/<body>-hillshade.pmtiles` on `nexus-assets`) and the search artifact and manifest under `planetary/<body>/<version>/` on the public bucket, where `version` is the build date compacted plus the first eight hex characters of the nomenclature archive's SHA-256, so a republish never overwrites an artifact a deployed app pins. It then fetches each public URL and reports the status. The R2 credentials are the `RCLONE_S3_*` variables `mailwoman tiles publish` reads; source the repo `.env` first.

The bin runs compiled: `yarn compile`, then `node packages/astrogeology/out/cli.js <command>`. Set `MAILWOMAN_DATA_ROOT` to the data root the sources and builds live under.

## Data-root layout

```text
$MAILWOMAN_DATA_ROOT/astrogeology/
  moon/
    source/  moon-nomenclature-<YYYY-MM-DD>.zip, Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif
    build/   moon.pmtiles, moon-hillshade.pmtiles, moon-search.ancestrie, manifest.json, moon.ndjson
  mars/
    source/  mars-nomenclature-<YYYY-MM-DD>.zip, Mars_MGS_MOLA_DEM_mosaic_global_463m.tif
    build/   mars.pmtiles, mars-hillshade.pmtiles, mars-search.ancestrie, manifest.json, mars.ndjson
```

## Coordinates

Every emitted artifact carries east-positive longitude in −180..180 and latitude in −90..90. The sources carry longitude in 0..360 with bounding boxes that may run past 360 (a feature on the prime meridian reads 359.2..360.16); `lib/normalize.ts` converts once, at build, and marks a box that crosses ±180 so a renderer splits it. The source convention is recorded in the manifest and in each archive's `mailwoman:*` block, never inferred by a consumer.

The shapefiles' CRS is each body's own, which PROJ refuses to relate to WGS84 and the GeoJSON writer insists on. The row reader declares the source as WGS84 on both sides of the `ogr2ogr` run so the numbers copy through untouched: a label on the transport only, since the build reads the rows' attributes and never their geometry.

## Tool prerequisites

GDAL 3.x with the MBTiles driver (`ogr2ogr`, `ogrinfo`, `gdaldem`, `gdal_translate`, `gdaladdo`, `gdalinfo`), `tippecanoe` 2.x, and the `pmtiles` CLI 1.x, all on the path. A missing tool fails a command with the tool's name. The fixture build under `test/integration/` runs the same chain over `test/fixtures/` and needs the same tools, which the lab's self-hosted runners carry.

## Attribution

The app renders these lines for the artifacts this pipeline builds:

- Nomenclature: USGS Astrogeology Science Center / IAU Working Group for Planetary System Nomenclature (public domain)
- Moon hillshade: NASA / LRO / LOLA, USGS Astrogeology Science Center (public domain)
- Mars hillshade: NASA / MGS / MOLA, USGS Astrogeology Science Center (public domain)
