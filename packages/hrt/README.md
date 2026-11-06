# hrt, the Hilbert Rust Tiler

`hrt` is a Rust rewrite of the Earth basemap builder, the Planetiler profile in
[`mailwoman/basemaps`](https://github.com/mailwoman/basemaps). The tile worker and Earth should not be able to tell
its archives from the Java build's. Issue #2902 holds the specification: the parity contract, the stages, the
performance items and the phases.

The name refers to the Hilbert curve, which orders every tile inside a PMTiles archive. The sort and the archive writer
follow that order.

This directory is a group of cargo crates with no npm package, like `packages/trainer`. The root `Cargo.toml` lists the
crates as default members, because none of them links libtorch.

## Crates

| Crate         | What it does                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `hrt-pmtiles` | PMTiles v3 reading and writing: Hilbert tile ids, the header, directories with leaf directories, and deduplication.                             |
| `hrt-e`       | Mapbox Vector Tile encoding and decoding: layers with interned keys and values, and zig-zag delta geometry commands.                            |
| `hrt-osm`     | OpenStreetMap reading in Planetiler's two passes: packed node locations, way geometry and multipolygon assembly.                                |
| `hrt-render`  | Planetiler's renderer: simplification, stripe clipping into tiles, polygon snapping, and MVT command encoding.                                  |
| `hrt-sort`    | Planetiler's 64-bit tile, layer and sort-key order, an external merge sort, and grouping into tiles with label grids.                           |
| `hrt-profile` | The basemap profile: the fork's `Matcher` rules, a `FeatureCollector`-style builder, OSM names with their `pgf:` encodings, merges, and layers. |
| `hrt-sources` | Inputs other than OpenStreetMap: GeoPackage, zipped shapefile and Overture GeoParquet readers.                                                  |
| `hrt-facade`  | Building facade styles for the compact building tiles, ported from Arnis: category, era, region, materials, window rhythm and ground floor.     |
| `hrt-cli`     | The `hrt` program: the build pipeline, `render-dump`, `basemap-test`, `clock` (the archive comparison) and `record`.                            |

`hrt-profile` holds thirteen of the fork's fourteen layers. `water` comes from OpenStreetMap, Natural Earth and the
prepared ocean polygons. `earth` comes from OpenStreetMap, Natural Earth and the prepared land polygons. `boundaries`
comes from OpenStreetMap and Natural Earth, and `landcover` from the Daylight landcover GeoPackage and Natural Earth.
`roads`, `buildings`, `places`, `pois`, `landuse`, `infrastructure`, `facilities`, `trees` and `transit` come from
OpenStreetMap.
`buildings` can also take its footprints from Overture's buildings theme, described below. The other Overture sources,
the canopy-raster treetops and the Overture-only `districts` layer are not ported. The fork's `transit` layer emits no
features. `hrt-cli` carries the parity profile and the basemap profile the comparisons below use.

### Overture buildings

`basemap-test - buildings.pmtiles layer=buildings overture-buildings=<dir>` builds the `buildings` layer from a synced
`theme=buildings/` directory of Overture's release, without an OpenStreetMap file. The input `-` skips both
OpenStreetMap passes. `bounds=<west,south,east,north>` limits the build. Without it, the archive covers the world.
`hrt-sources`' `overture` reader reads the row groups in parallel. It reads `theme` and `type` from the hive directory
names, as the fork's `--overture_buildings` does, and skips row groups and rows whose `bbox` lies outside the bounds.
With an OpenStreetMap file as well, OpenStreetMap contributes only the address points. `no-footprints` keeps only those
address points, for an OpenStreetMap archive whose footprints come from a separate Overture archive.

The fork's Java build of 2026-10-23 (`planet.v4`) read the Overture release that was latest that day, and its archive
does not record which one, so this comparison checks counts rather than bytes. On a 4 km Osaka box (135.48–135.52° E, 34.66–34.70° N) from release
2026-10-21.0, with 35,223 buildings and 379 building parts, tile `15/28718/13015` held 3,855 buildings, 4 building
parts and 2,810 heights in both archives. `planet.v4` predates the fork's `height_src`, `district` and `class`
attributes, so only the `hrt` tile has them.

### Compact building tiles

`hrt building-tiles <theme=buildings dir> <out.pmtiles> [bounds=<west,south,east,north>] [osm=<file.osm.pbf>]` writes
an archive for Earth's GPU building layer. With an OpenStreetMap file, each building joins the tags of the way or
relation its Overture `sources` names, and each exterior wall is classified as a street, rear, party or open wall
against the file's roads and the neighboring footprints, by rules adapted from Arnis (`hrt-profile/src/facade_plan.rs`). The page parameter `?buildings3d=<tileset>` turns that layer on. Each building is written once, into the z14 tile
that holds the center of its bounding box, with coordinates relative to that tile in 8,192 units per side. Each record
holds the building's id, heights, colors, floor count, roof shape, footprint rings and roof triangles.
`hrt-profile/src/building_buffers.rs` documents the record layout. The archive has tile type `Unknown` and no archive
compression. Each tile body is gzipped, so the tile worker serves it as `.bin` unchanged and the browser decompresses
it.

On the 4 km Osaka box above, 35,602 Overture rows gave 35,496 building records in 9 tiles and a 1,237,024-byte archive,
about 34.8 bytes per building. The vector-tile archive of the same box for z11 to z15 is 3,529,317 bytes. Earth's
decoder turns the 9 tiles into 6,683,084 bytes of GPU buffers, about 188 bytes per building.

`hrt-render`'s `java_math` module translates the fdlibm functions behind Java's `Math.hypot`, `sinh`, `atan` and
`atan2`. On 200,000 inputs, Rust's own `hypot` differed from Java's in the last bit for 26,528 (13%). JTS measures
lengths with `Math.hypot`, and the road smoothing places points with it. A last-bit difference in a smoothed point
changed which vertex Douglas-Peucker kept in 63 of 6,350 Luxembourg road tiles. With the translations, every probe
input matched Java's bits. `Math.cos` remains the platform's, because HotSpot replaces it with an intrinsic. Its result
differed for 456 of the 200,000 inputs. It sets only the smoothing's 6-meter cap, and every tile matched.

`hrt-render` links GEOS, built from source by the `geos` crate's `static` feature, so building it needs cmake and a C++
compiler. GEOS ports the JTS validity test and precision reducer Planetiler calls when a polygon's rounded form is
invalid.

## Checks

```sh
cargo test -p hrt-pmtiles -p hrt-e -p hrt-osm -p hrt-render -p hrt-sort -p hrt-profile -p hrt-sources -p hrt-facade -p hrt-cli
cargo clippy -p hrt-pmtiles -p hrt-e -p hrt-osm -p hrt-render -p hrt-sort -p hrt-profile -p hrt-sources -p hrt-facade -p hrt-cli \
  --all-targets -- -D warnings
```

The unit tests encode the vector tile specification's own examples and read written archives back through their
directories.

A second check reads `hrt` output with the readers production uses. `hrt-e`'s `fixture` example writes an archive in
which every tile records its own zoom, column and row:

```sh
cargo run --release -p hrt-e --example fixture -- fixture.pmtiles 9
```

The script that reads it lives outside the repository. It opens the archive with the `pmtiles` JavaScript library the
tile worker uses, decodes each tile with `@mailwoman/map-tui/mvt`, and checks the recorded numbers. On 2026-11-02 it
checked all 341 tiles of a zoom-4 archive and 14,873 sampled tiles of a zoom-9 archive. The zoom-9 archive has 349,525
tiles in 86 leaf directories, and every sampled tile matched.

## Reader parity with Planetiler

`parity/OsmDump.java` runs Planetiler's own OSM reader through a profile that keeps every relation and prints each
source feature: its element type and id, whether it can be a line or a polygon, its relation memberships, and its world
coordinates as the bits of each double. `hrt-osm`'s `parity-dump` example prints the same lines. The Java program runs
against the basemaps fork's shaded jar, which bundles Planetiler 0.10.2:

```sh
java -cp protomaps-basemap-HEAD-with-deps.jar packages/hrt/parity/OsmDump.java input.osm.pbf scratch/ > java.txt
cargo run --release -p hrt-osm --example parity-dump -- input.osm.pbf > rust.txt
```

Planetiler's pass 1 runs on several threads, so the order of a feature's memberships varies between Java runs. Sort
each line's `rels=` list and then the lines before comparing. On 2026-11-02 the two outputs were identical after that
sort for two inputs:

| Input                                        | Features | Multipolygon relations | Relations neither reader could build |
| -------------------------------------------- | -------: | ---------------------: | -----------------------------------: |
| Geofabrik `monaco-latest.osm.pbf`, 706,867 B |   10,643 |                     99 |                                    2 |
| The fork's `sf-downtown.osm.pbf` fixture     |   40,050 |                    202 |                                    3 |

Two differences from Planetiler leave the output unchanged on these inputs. `hrt-osm` skips untagged nodes, which no
profile rule matches. geo's `relate` returns a result on invalid rings where JTS raises a topology exception, so
`hrt-osm` has no counterpart to Planetiler's retry after `buffer(0)`. Neither input exercised that retry.

## Renderer parity with Planetiler

`parity/RenderDump.java` runs a fixed profile through Planetiler's `FeatureRenderer` and prints every tile piece: the
tile, layer, feature id, geometry type, scale, sort key, label-grid group and the MVT command integers. The profile
sends tagged nodes to a point layer, ways and multipolygons that can be polygons to a polygon layer, and other ways to a
line layer, with Planetiler's default sizes, tolerances and buffers at zooms 0 to 14. `hrt render-dump` runs the same
profile over `hrt-osm`. Both dumps render whole-world tile extents:

```sh
java -cp protomaps-basemap-HEAD-with-deps.jar packages/hrt/parity/RenderDump.java input.osm.pbf scratch/ > java.txt
cargo run --release -p hrt-cli -- render-dump input.osm.pbf > rust.txt
```

On 2026-11-02 the sorted outputs compared as follows:

| Input                   | Tile pieces | Identical | Ring start rotated | Polygons sent to the precision reducer |
| ----------------------- | ----------: | --------: | -----------------: | -------------------------------------: |
| `monaco-latest.osm.pbf` |      80,483 |    80,441 |                 42 |                                     42 |
| `sf-downtown.osm.pbf`   |     338,329 |   338,075 |                254 |                                    256 |

Every differing piece has the same rings, the same vertices and the same signed ring areas as Planetiler's. The
precision reducer in GEOS starts some rings at a different vertex from the JTS one, which encodes the same polygon with
different commands. The archive comparison tool therefore compares polygon rings up to rotation.

## Archive parity and timing

The Java run of `RenderDump.java` also writes Planetiler's archive for the profile, to `scratch/out.pmtiles`, with the
map bounds taken from the input file's header. `hrt render-test` builds the same profile into an archive with the same
bounds, and `hrt clock` compares the two:

```sh
java -cp protomaps-basemap-HEAD-with-deps.jar packages/hrt/parity/RenderDump.java input.osm.pbf scratch/ 4 quiet
cargo run --release -p hrt-cli -- render-test input.osm.pbf rust.pmtiles
cargo run --release -p hrt-cli -- clock scratch/out.pmtiles rust.pmtiles
cargo run --release -p hrt-cli -- record rust.pmtiles rust.jsonl
```

`clock` exits 0 when every tile is in both archives and every shared tile holds equal layers. `record` writes one JSON
line per tile with each layer's feature count and a digest of its features in the form `clock` compares. Two archives
that `clock` calls equal give the same record. On 2026-11-02 the Java and `hrt` archives were equal on every tile:

| Input                                          | Tiles | Equal | Byte-identical after gunzip | Features compared |
| ---------------------------------------------- | ----: | ----: | --------------------------: | ----------------: |
| `monaco-latest.osm.pbf`                        |   119 |   119 |                         108 |            35,154 |
| `sf-downtown.osm.pbf`                          |    27 |    27 |                           8 |           203,527 |
| Geofabrik `luxembourg-latest.osm.pbf`, 47.9 MB | 2,079 | 2,079 |                         329 |         4,643,613 |

The tiles that are not byte-identical hold polygons whose rings start at a different vertex, as described above.

Luxembourg also gave a first timing on the lab host (16 cores, load average 1.45 at the start), both builds limited to
four threads. The parity profile writes no attributes and runs no post-processing, so these figures measure reading,
rendering, sorting and encoding. The basemap profile's attribute and merge work adds to both builds:

| Build                                                                 | Wall clock | CPU time | Peak resident memory |
| --------------------------------------------------------------------- | ---------: | -------: | -------------------: |
| Planetiler 0.10.2, `--threads=4`                                      |       30 s |    113 s |         not measured |
| `hrt render-test`, `RAYON_NUM_THREADS=4`, tiles encoded on one thread |     11.6 s |     23 s |               395 MB |
| `hrt render-test`, `RAYON_NUM_THREADS=4`, tiles encoded in parallel   |     10.1 s |     29 s |               534 MB |

The Planetiler figures are its own stage table and exclude JVM start-up. Its stages were pass 1 2 s, pass 2 17 s, sort
4 s and archive 7 s. The first `hrt` run used 199% CPU of the four threads because it encoded tiles on one thread. The
second encodes each batch of tiles on rayon's threads and writes them in tile order. It used 285% CPU, and the host's
load average had risen to 18.5 from other jobs by the time it finished, so its CPU time includes contention. These are
single runs on a shared host. The Phase 0 baseline and `hrt titrate` repeat them under controlled load.

## Water layer parity

`parity/LayerDump.java` builds an archive of one layer of the fork's own `Basemap` profile at maxzoom 15, so the fork's
source routing, relation preprocessing and per-layer post-processing all run. For water, OpenStreetMap features go
through `Water.processOsm`, Natural Earth features through `Water.processNe`, the prepared ocean polygons through
`Water.processPreparedOsm`, and every tile through `Water.postProcess`. `hrt basemap-test` builds the same layers from
`hrt-profile`'s port, reading the GeoPackage and the zipped shapefile with `hrt-sources`. With `raw`, both skip
post-processing, which isolates the line and polygon merges.

```sh
java -cp protomaps-basemap-HEAD-with-deps.jar packages/hrt/parity/LayerDump.java water input.osm.pbf scratch/ 4 \
  ne=natural_earth_vector.gpkg.zip osm-water=water-polygons-split-3857.zip
cargo run --release -p hrt-cli -- basemap-test input.osm.pbf water.pmtiles layer=water \
  ne=natural_earth_vector.gpkg.zip osm-water=water-polygons-split-3857.zip
cargo run --release -p hrt-cli -- clock scratch/water.pmtiles water.pmtiles
```

The two inputs are Natural Earth's `natural_earth_vector.gpkg.zip` (446,353,155 bytes) and osmdata's
`water-polygons-split-3857.zip` (931,892,733 bytes), as downloaded on 2026-11-02. `hrt` extracts each beside the
archive, in a `.hrt-unzipped` directory, and reuses the extraction.

On 2026-11-02:

| Input and sources                               | Tiles | Equal | Equal within the polygon tolerance | Different |
| ----------------------------------------------- | ----: | ----: | ---------------------------------: | --------: |
| `monaco-latest.osm.pbf`, all three              |   873 |   873 |                                  0 |         0 |
| `sf-downtown.osm.pbf`, all three                |    46 |    46 |                                  0 |         0 |
| `monaco-latest.osm.pbf`, OpenStreetMap only     |    21 |    21 |                                  0 |         0 |
| `sf-downtown.osm.pbf`, OpenStreetMap only       |    28 |    28 |                                  0 |         0 |
| `luxembourg-latest.osm.pbf`, OpenStreetMap only | 6,009 | 6,006 |                                  4 |         3 |

The prepared ocean polygons are in EPSG:3857. Planetiler converts them to longitude and latitude through GeoTools and
then to world coordinates, and `hrt` applies the same two formulas. Every Monaco and San Francisco tile was equal without
a vertex tolerance.

Without post-processing, all 6,015 Luxembourg tiles and their 75,794 features were identical, so the three remaining
differences come from `mergeNearbyPolygons`. `hrt merge-probe` and `parity/MergeProbe.java` run that merge step by step
on one tile's input. For tile 10/529/348 the buffered union has the same area in both, 170.2070 square pixels, and
shrinking it back by the 0.0625 pixel buffer gives 68.0000 square pixels in JTS and 93.2207 in GEOS. The twelve input
polygons cover about 93 square pixels once a duplicated input is counted once, so the JTS result lost area. This is
inferred to be the JTS buffer fault Planetiler's own comment cites, locationtech/jts#1183, whose fallback Planetiler
applies only when an input exceeds 100 square pixels. The other two tiles differ in merged polygon vertices, with
intersection over union 0.9926 and 0.9989.

## Roads layer parity

The roads layer looks up each highway's country in the country-coder border polygons the fork bundles as
`tiles/src/main/resources/borders.json`, and `basemap-test` reads the same file through `borders=`. `LayerDump.java`
uses the jar's copy.

```sh
java -cp protomaps-basemap-HEAD-with-deps.jar packages/hrt/parity/LayerDump.java roads input.osm.pbf scratch/ 4
cargo run --release -p hrt-cli -- basemap-test input.osm.pbf roads.pmtiles layer=roads borders=borders.json
cargo run --release -p hrt-cli -- clock scratch/roads.pmtiles roads.pmtiles
```

On 2026-11-02, every tile was equal without a vertex tolerance:

| Input                       | Tiles | Features | Equal |
| --------------------------- | ----: | -------: | ----: |
| `monaco-latest.osm.pbf`     |    28 |    2,248 |    28 |
| `sf-downtown.osm.pbf`       |    43 |    4,599 |    43 |
| `luxembourg-latest.osm.pbf` | 6,350 |  131,136 | 6,350 |

Without post-processing, the 6,350 Luxembourg tiles and their 649,223 features were also equal. The Overture
transportation source of the Java layer is not ported.

## Earth, infrastructure, facilities and trees parity

The Earth layer reads osmdata's `land-polygons-split-3857.zip` (952,775,197 bytes, downloaded on 2026-11-02) through
`osm-land=` in both builds, besides Natural Earth through `ne=`. The comparison jar was rebuilt on 2026-11-02 at the
fork's HEAD, 8bb24b2, because the earlier jar predates the facilities layer.

On 2026-11-02, every tile was equal without a vertex tolerance, and most were byte-identical:

| Layer            | Input                       |  Tiles |    Features |  Equal | Byte-identical |
| ---------------- | --------------------------- | -----: | ----------: | -----: | -------------: |
| `earth`          | `monaco-latest.osm.pbf`     |     48 |          71 |     48 |             25 |
| `earth`          | `luxembourg-latest.osm.pbf` | 10,585 |      80,468 | 10,585 |         10,579 |
| `infrastructure` | `monaco-latest.osm.pbf`     |     15 |       1,881 |     15 |             15 |
| `infrastructure` | `luxembourg-latest.osm.pbf` |  5,856 |     150,462 |  5,856 |          5,851 |
| `facilities`     | `monaco-latest.osm.pbf`     |      0 |           0 |      0 |              0 |
| `facilities`     | `luxembourg-latest.osm.pbf` |    220 |         404 |    220 |            220 |
| `trees`          | `monaco-latest.osm.pbf`     |      9 |       2,192 |      9 |              9 |
| `trees`          | `luxembourg-latest.osm.pbf` |  3,811 |     621,777 |  3,811 |          3,797 |
| `roads`          | `monaco-latest.osm.pbf`     |     28 |       2,248 |     28 |             28 |
| `roads`          | `luxembourg-latest.osm.pbf` |  6,350 |     131,136 |  6,350 |          6,350 |
| `landuse`        | `monaco-latest.osm.pbf`     |     25 |         547 |     25 |             14 |
| `landuse`        | `luxembourg-latest.osm.pbf` |  6,757 |     635,928 |  6,757 |            738 |
| `boundaries`     | `monaco-latest.osm.pbf`     |     30 | not counted |     30 |             30 |
| `boundaries`     | `luxembourg-latest.osm.pbf` |  3,782 | not counted |  3,782 |          3,782 |
| `places`         | `monaco-latest.osm.pbf`     |     24 | not counted |     24 |             24 |
| `places`         | `luxembourg-latest.osm.pbf` |  3,434 | not counted |  3,434 |          3,434 |

| `pois` | `monaco-latest.osm.pbf` | 26 | not counted | 26 | 26 |
| `pois` | `luxembourg-latest.osm.pbf` | 5,853 | not counted | 5,853 | 5,853 |

The places rows read the curated label zooms from the fork's `tiles/src/main/resources/places.csv` through
`places=`, as the fork reads them from its jar. The pois rows run with an empty QRank table on both sides, so no POI
takes a zoom from its page-view rank. `LayerDump.java` passes the empty table because the fork's `Pois` throws on a
`wikidata` tag when it has none. A production build reads the gzipped `qrank.csv`, which `basemap-test` takes through `qrank=`.

The `landcover` layer comes from the Daylight landcover GeoPackage through `landcover=`, plus Natural Earth's
Antarctic glaciers. Monaco and Luxembourg lie outside both: with Natural Earth only, both builds write an empty
archive for each. The Daylight path has unit tests and no parity run yet. The GeoPackage is a large download, which
belongs on the AWS build host.

For `buildings`, the counts below include tiles equal within the polygon tolerance:

| Input                       | Tiles | Features | Equal | Within tolerance | Byte-identical | Different |
| --------------------------- | ----: | -------: | ----: | ---------------: | -------------: | --------: |
| `monaco-latest.osm.pbf`     |    24 |    5,609 |    24 |                2 |              6 |         0 |
| `luxembourg-latest.osm.pbf` | 5,073 |  261,784 | 5,069 |               24 |          4,580 |         4 |

The four differing Luxembourg tiles are at zoom 12, where footprints merge into blocks through a buffer and union,
GEOS's in `hrt` and JTS's in Planetiler. Their first differing polygons have intersection over union 0.917277,
0.996032, 0.998764 and 0.996073. In the first, tile 12/2115/1390, Java's polygon has 10 rings and 54.4 square pixels
against `hrt`'s 9 rings and 49.9.

The boundaries rows read Natural Earth through `ne=` as well. Natural Earth's admin boundary lines are multi-lines, and
a non-OSM source's multi-line is a line, as Planetiler's `SimpleFeature` treats it. Within map bounds the GeoPackage
reader returns each table's rows in ascending key order, the order geopackage-java hands Planetiler. All 558 Natural
Earth records inside Luxembourg's bounds then carry the same running number in both readers.

A tile equal in content but not in bytes holds a polygon whose ring starts at another vertex. Some polygons turn invalid
when their vertices round to the tile grid, and both builds repair them with a precision reducer: JTS's in Planetiler, GEOS's port in
`hrt`. The two start the repaired rings at different vertices. In Luxembourg, 25,175 landuse polygon renderings took
that path. `hrt clock` prints, for each zoom, the first such feature.

The fork's paddy rule never applies to `landuse=farmland` with `crop=rice`: the fork's `getString` returns the last
matching rule, and the general `landuse` rule follows the paddy rule. Both builds therefore give `farmland`, and only
`landuse=paddy` gets `paddy`.

Two orders decide the bytes. Features that tie on tile, layer and sort key are ordered by their sort records, which
`hrt-sort` writes as the MessagePack value Planetiler's `FeatureGroup` writes, attributes in key order. Before this
encoding, a tree's crown sorted ahead of its trunk in 3,121 Luxembourg tiles, because a little-endian 8.0 compared below
3.3. A feature's tags are written in the iteration order of the Java `HashMap` Planetiler decodes them into, which the
record decoder reproduces. One difference stays: Planetiler writes attribute keys as numbers assigned in first-use
order across worker threads, so ties between features with different key sets order by thread scheduling in Java.

The `trees` layer's canopy-raster source, `pm:treetops`, is a Parquet file `hrt` does not read yet.

Island labels sit at the center of each island's maximum inscribed circle. `hrt-render`'s `inscribed` module ports
the JTS 1.20 search Planetiler calls, seeded at GEOS's interior point. GEOS's own port of the search placed one Kii
Peninsula island's label 98 tile units from Java's, because GEOS measures distances with `sqrt(dx*dx + dy*dy)` where
JTS uses `Math.hypot`, orders its cell queue differently, and solves triangles and convex quadrilaterals exactly. The
port measures with Java's `hypot` and orders cells as `java.util.PriorityQueue` does. With it, the earth layers of
Geofabrik's Chūgoku (791 tiles) and Kansai (709 tiles) extracts, built from OpenStreetMap alone so that their islands
and cliffs are the only features, were byte-identical to Java's.

Both builds write a header zoom range of 0 to 15 whichever zooms hold tiles. The header center differs: Planetiler
writes the middle of the bounds at a zoom fitted to them, and `hrt` writes zoom 0 at 0, 0.

## Clip parity

`hrt-profile`'s `clip` module ports the fork's `Clip` tile post-processor, which Basemap's `--clip` and
`--clip-buffer` register. `basemap-test` and `LayerDump.java` take `clip=<polygon.geojson>` and `clip-buffer=<pixels>`.
As in Planetiler, the clip runs on a whole tile before each layer's post-processing. The rows below clip to a
pentagon with a rectangular hole across Luxembourg, and to a quadrilateral across Monaco, both with the default
4-pixel buffer:

| Input      | Layer          | Tiles | Equal | Byte-identical | Lines joined differently | Other differences |
| ---------- | -------------- | ----: | ----: | -------------: | -----------------------: | ----------------: |
| Monaco     | roads          |    23 |    19 |             19 |                        4 |                 0 |
| Monaco     | earth          |    10 |    10 |             10 |                        0 |                 0 |
| Monaco     | pois           |    18 |    18 |             18 |                        0 |                 0 |
| Monaco     | buildings      |    19 |    19 |              0 |                        0 |                 0 |
| Luxembourg | roads          | 4,123 | 4,114 |          4,114 |                        9 |                 0 |
| Luxembourg | infrastructure | 3,799 | 3,717 |          3,654 |                       82 |                 0 |
| Luxembourg | buildings      | 3,392 | 3,388 |          2,720 |                        0 |                 4 |
| Luxembourg | landuse        | 4,213 | 4,212 |            304 |                        0 |                 1 |
| Luxembourg | pois           | 3,852 | 3,852 |          3,852 |                        0 |                 0 |
| Luxembourg | places         | 2,237 | 2,237 |          2,237 |                        0 |                 0 |
| Luxembourg | trees          | 2,504 | 2,504 |          2,339 |                        0 |                 0 |
| Luxembourg | facilities     |   151 |   151 |            151 |                        0 |                 0 |

A line clipped by a polygon comes back from OverlayNG in pieces in JTS 1.20, whose `LineBuilder` writes each noded
edge as its own line, and as maximal lines in GEOS, whose `LineBuilder` joins edges through nodes where only two meet.
`Clip` writes each piece as a feature, so a road can reach the roads line merger as two features in Java and one in
`hrt`, and the merged line then keeps another piece's id. `hrt clock` counts a differing tile whose line features
with each attribute map cover the same segments as joined differently. `hrt` keeps GEOS's maximal lines.

The four other building differences are the zoom-12 block merges of the unclipped run. The landuse difference is a
Planetiler defect. Its `TileArchiveWriter` reuses the previous tile's encoded bytes when a tile's features before
post-processing equal the previous tile's, which skips `Clip` for the second tile. Tiles 15/16962/11129 and
15/16962/11130 each hold the same forest filling the whole tile, and Java wrote the first tile's clipped forest into
both. Planetiler's own slicer, run on the buffered clip with the fork's jar, gives 15/16962/11130 the same clip piece
as `hrt`, and `hrt`'s tile holds the forest clipped to that piece.

Four equal landuse tiles hold the same features in another order. In the three `hrt clock` printed, the first feature
out of order is a forest relation that the clip split into several polygons, which suggests GEOS's overlay lists a
multipolygon's members in a different order from JTS's. That cause is not yet tested.

## Devanagari name encoding parity

MapLibre places glyphs one codepoint at a time, so it cannot draw Devanagari's conjuncts and vowel signs. The fork
works around this with Wipfli's positioned-glyph-font (pgf) encoding. It shapes each name in a registered script with
that script's font, looks each positioned glyph up in an encoding table, and writes the result as a `pgf:` attribute
of Private Use Area codepoints. The label layers of `@protomaps/basemaps`, which `packages/cartographer` builds its
styles from, read `pgf:name` and switch Devanagari labels to the `Noto Sans Devanagari Regular v1` fontstack, which
the glyph bucket serves.

`hrt-profile`'s `pgf` module ports the fork's `FontRegistry` and `TextEngine`. `basemap-test` and `LayerDump.java`
take `pgf=<pgf-encoding.zip>` and register the fonts Basemap's main registers, which is only Noto Sans Devanagari with
encoding version 1. The archive Basemap downloads holds the same font and table files as the fork's test fixture.

The table key is a glyph id with its offset and advance in 1/64ths of a 1000-unit em, as the JDK computes them for a
1-point font. The JDK shapes with HarfBuzz at a scale of 65,536 per point. HarfBuzz takes each glyph's advance from
FreeType's linear advance, `round(advance × round(64 × 65,536 / 1000) / 64)` in 16.16. The key offset is the glyph's
float position less the float sum of the metric advances before it. `hrt` shapes with HarfRust 0.15, which follows
HarfBuzz 15.0.0, at the same scale with the same advance callback, kerning and standard ligatures off, and no language.
The FreeType formula matched the JDK's advance bits for all 257 glyphs the corpus below uses.

`hrt pgf-probe` and `parity/PgfProbe.java` encode a list of names. Run on the 15,867 distinct Natural Earth name
values that contain a Devanagari character, Java and `hrt` wrote the same codepoints for every name, and neither
found a glyph missing from the table. The tile builds below register the fonts:

| Input      | Layer  | Tiles | Byte-identical | Features with `pgf:` attributes |
| ---------- | ------ | ----: | -------------: | ------------------------------: |
| Monaco     | pois   |    26 |             26 |                              12 |
| Monaco     | places |    24 |             24 |                               0 |
| Monaco     | roads  |    28 |             28 |                               0 |
| Luxembourg | places | 3,434 |          3,434 |                              29 |
| Luxembourg | pois   | 5,853 |          5,853 |                               6 |
| Luxembourg | roads  | 6,350 |          6,350 |                               0 |

The attributes are `pgf:name:hi`, `pgf:name:mr` and `pgf:name:ne`. No feature in either area has a Devanagari
`name`, so `pgf:name`, `pgf:name2` and `pgf:name3` are compared only through the name corpus. Both archives carry the
fork's metadata keys `pgf:devanagari:name` and `pgf:devanagari:version`. Earth and water were built too. Monaco's earth and
water and Luxembourg's 2,926 earth tiles were byte-identical, and Luxembourg's water differed in the 3 tiles of the
water layer's polygon merges recorded above.

## Japan build

On 2026-11-02 both builds ran on one AWS r7gd.8xlarge (32 Graviton3 vCPUs, 256 GB, instance-store scratch) from
Geofabrik's `japan-latest.osm.pbf` (2,566,575,684 bytes) with every source the fork reads except Overture and the
canopy raster: Natural Earth, the osmdata water and land polygons, the Daylight landcover GeoPackage and the pgf
encoding. The Java build was `LayerDump.java` with an empty layer name, so Basemap built all of its layers, on the fork
at 8bb24b2 with `-Xmx64g`. The `hrt` build was `hrt basemap-test` with the thirteen ported layers at e0c830c6b, before
the relation-order change below. Both used 32 threads.

| Build              | Wall clock | User CPU | System CPU | Peak resident memory | Archive bytes |
| ------------------ | ---------: | -------: | ---------: | -------------------: | ------------: |
| Java, `-Xmx64g`    |    5:33.92 |  6,192 s |       72 s |              69.1 GB |  not recorded |
| `hrt basemap-test` |    5:28.25 |  5,418 s |       35 s |              15.8 GB | 4,098,754,482 |

Both archives hold 10,997,053 tiles. `hrt clock` compared 114,454,085 features. 10,996,236 tiles were equal: 10,666,498
byte-identical after gunzip, one with the same features in another order, and 5,732 whose 6,235 differing polygons
were equal within the polygon tolerance. 817 tiles differed. By layer, counting tiles whose layer digest differed and
tiles whose layer feature count differed:

| Layer       | Digest differs | Count differs |
| ----------- | -------------: | ------------: |
| `water`     |          5,537 |             0 |
| `buildings` |          1,034 |             2 |
| `earth`     |            246 |             1 |
| `roads`     |            187 |           132 |
| `landuse`   |             16 |             0 |
| `landcover` |              2 |             0 |

The digest counts include tiles equal within tolerance. `boundaries`, `facilities`, `infrastructure`, `places`, `pois`
and `trees` matched in every tile.

The `roads` differences came from the order of a way's relation memberships. The fork orders road shields by network
rank and text, and keeps shields that sort equal in the order Planetiler returns the way's relations. Planetiler stores
memberships in `SparseUnorderedBinarySearchMultimap`, whose lookup binary-searches all keys and collects a key's values
forward from where the search lands, then backward, so the order depends on every other key in the table. `hrt-osm`'s
`BinarySearchMultimap` reproduces that lookup. On Geofabrik's `chugoku-latest.osm.pbf`, the roads layer differed in 65
of 48,849 tiles before the change and was byte-identical in all 48,849 after it.

A second `hrt` build at ba10b6785, with this change and the two below, read the same extract (sha256 `34784d4e…`, the
dated `japan-261101.osm.pbf`) and the same other inputs, whose sha256 sums matched the first run's. It ran alone on an
m7gd.4xlarge (16 vCPUs, 64 GB) in 7:21.74 with 15.7 GB peak resident memory, sorted 189,423,246 records, the count of
features Java wrote, and was compared with the first run's Java record:

| Layer       | Count differs, first run | Count differs, second run | Digest differs, first run | Digest differs, second run |
| ----------- | -----------------------: | ------------------------: | ------------------------: | -------------------------: |
| `roads`     |                      132 |                         0 |                       187 |                          1 |
| `earth`     |                        1 |                         0 |                       246 |                        234 |
| `buildings` |                        2 |                         1 |                     1,034 |                      1,000 |
| `water`     |                        0 |                         0 |                     5,537 |                      5,537 |
| `landuse`   |                        0 |                         0 |                        16 |                         16 |
| `landcover` |                        0 |                         0 |                         2 |                          2 |

The remaining count difference is the building merge at 12/3578/1635 described below. The remaining `roads` tile,
13/7208/3197, holds 42 features in both builds and matched Java in the first run, so the relation-order change moved
it. A roads-only build of Geofabrik's `chubu-latest.osm.pbf` was byte-identical to Java's in all 93,277 tiles,
including this one. A build of one region fills the membership table with that region's relations only, and where a
lookup lands depends on every key in the table, so this tile's cause is not established.

The differing polygons in `water`, `buildings`, `landuse` and `landcover` are the polygon merges recorded for
Luxembourg: GEOS's buffer, union and precision reducer in `hrt`, JTS's in Planetiler. In the 200 tiles `clock`
detailed, the first differing polygon had intersection over union between 0.96 and 0.9999. The bundled GEOS is 3.15.1dev,
which its version file records as a port of JTS 1.20.0, the JTS Planetiler 0.10.2 uses. The two still return different
rings for the same input. During merges, Planetiler snapped and repaired 66 polygons and `hrt` 70. During rendering,
both repaired 581,396.

Three tiles outside `roads` held different feature counts. Each was rebuilt on the lab host from a small Geofabrik
extract around it:

- `earth` 15/28705/13122 (Java 1, `hrt` 2): GEOS placed the label of island way 719082768 98 tile units from Java's,
  inside this tile's buffer. The ported inscribed-circle search above places it where Java does.
- `buildings` 12/3577/1635 (Java 2, `hrt` 1): way 313671577 is tagged `building:levels=２（店舗スペース）`.
  Planetiler's fallback number parser, `NumberFormat`, reads every decimal digit Java's `Character.digit` knows,
  including the fullwidth `２`, and gave a height of 8 meters. `hrt` read ASCII digits only and gave no height, so the
  footprint joined another merge group. `hrt-profile`'s parser now reads the same 370 digits as JDK 21. Five of the six
  differing building tiles in the Shikoku extract around this tile were this footprint, at zooms 11 to 15.
- `buildings` 12/3578/1635 (Java 2, `hrt` 3): a pair of footprints of height 40 merges to 3.09375 square pixels in
  JTS and 3.1348 in GEOS, whose ring keeps one more vertex. The merge's minimum area is 3.125 square pixels, so Java
  drops the pair and `hrt` keeps it. This is a polygon merge difference.

### Java profile

A second run on the same instance type recorded the Java build with the JDK's Flight Recorder
(`-XX:StartFlightRecording=settings=profile`) and its GC log. async-profiler 4.0 crashed this arm64 Corretto 21.0.13
JVM in `vframeStreamForte::forte_next`. The profiled build took 5:31.04 with 6,071 s of user CPU and 69.1 GB peak
resident memory. Planetiler's stage table:

| Stage       | Wall clock |     CPU | Cores busy on average |
| ----------- | ---------: | ------: | --------------------: |
| `osm_pass1` |       26 s |   2m47s |                   6.4 |
| `osm_pass2` |      2m18s | 1h7m58s |                  29.5 |
| `ne`        |      1m14s |   1m22s |                   1.1 |
| `osm_water` |       14 s |    58 s |                   4.1 |
| `osm_land`  |       14 s |    37 s |                   2.6 |
| `sort`      |       10 s |   3m39s |                  21.9 |
| `archive`   |       50 s |  24m39s |                  29.6 |

The Natural Earth stage read on about one core for 1m14s, 23% of the 5m28s Planetiler reported for the whole build.
Garbage collection paused the build 927 times for 9.09 s in total (median 4.44 ms, 99th percentile 111 ms), and its
threads used 2m56s of user CPU, about 3% of the build's. Of 89,456 CPU samples, the most frequent methods were
`Arrays.copyOf(Object[])` (6.13%), Planetiler's `DouglasPeuckerSimplifier.subsimplify` (4.39%, and 1.58% in its
second overload), hppc's `DoubleArrayList.ensureBufferSpace` (2.79%), `HashMap.getNode` (2.61%) and JTS's
`MonotoneChain.computeIntersections` (2.46%). The largest allocation sites were `Arrays.copyOf(double[])` (12.58%),
JTS's `SimpleMCSweepLineIntersector.addEdge` (8.10%), `Arrays.copyOf(Object[])` (5.91%) and `ArrayList.grow` (5.45%).

Planetiler names its threads after their stage, so the samples split by stage:

| Thread                  | CPU samples | Most frequent methods                                                                                      |
| ----------------------- | ----------: | ---------------------------------------------------------------------------------------------------------- |
| `osm_pass2_process`     |      56,151 | `Arrays.copyOf(Object[])` (4,710), `subsimplify` (3,635), JTS `MonotoneChain.computeIntersections` (2,185) |
| `archive_encode`        |      17,794 | `subsimplify` (1,417), `HashMap.getNode` (1,218), `ArrayList.add` (1,193), `HashMap.resize` (943)          |
| `osm_pass1_parse`       |       5,746 | `DenseNodeIterator.next` (1,394), `String.hashCode` (822), protobuf `readRawVarint32` (628)                |
| `osm_water_process`     |       2,634 |                                                                                                            |
| `osm_pass1_process`     |       2,063 |                                                                                                            |
| `osm_land_process`      |       1,375 |                                                                                                            |
| `ne_read`, `ne_process` |         141 |                                                                                                            |

The Natural Earth stage took 1m14s yet holds 141 CPU samples. It logged its start at 0:02:45 and its first rows read
at 0:03:31, then read about 10,000 rows, 3% of the file, because the rest lie outside Japan's bounds. The 46 seconds
before the first row are inferred to be the extraction of the 446 MB `natural_earth_vector.gpkg.zip`, which runs in
I/O and native inflate, outside the Java code the Flight Recorder's execution sampler records.

The unprofiled Java build's log records its temporary storage and largest tiles. It used a 2.5 GB node location cache, a
393 MB multipolygon geometry cache and a feature database that peaked at 18 GB, and it wrote 189,423,246 features into
10,997,053 tiles. Planetiler printed the archive size only as 4G, and `hrt`'s archive was 4,098,754,482 bytes. The largest
gzipped tile was 13/7274/3224 in Tokyo, 1.3 MB, of which buildings were 2.8 MB before compression. By zoom, the largest
gzipped tile grew from 14 kB at z0 to 246 kB at z9 and peaked at z13.
