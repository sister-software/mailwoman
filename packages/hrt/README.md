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

| Crate         | What it does                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `hrt-pmtiles` | PMTiles v3 reading and writing: Hilbert tile ids, the header, directories with leaf directories, and deduplication.   |
| `hrt-e`       | Mapbox Vector Tile encoding and decoding: layers with interned keys and values, and zig-zag delta geometry commands.  |
| `hrt-osm`     | OpenStreetMap reading in Planetiler's two passes: packed node locations, way geometry and multipolygon assembly.      |
| `hrt-render`  | Planetiler's renderer: simplification, stripe clipping into tiles, polygon snapping, and MVT command encoding.        |
| `hrt-sort`    | Planetiler's 64-bit tile, layer and sort-key order, an external merge sort, and grouping into tiles with label grids. |
| `hrt-profile` | The basemap profile: the fork's `Matcher` rules, a `FeatureCollector`-style builder, OSM names, merges, and layers.   |
| `hrt-sources` | Inputs other than OpenStreetMap: GeoPackage and zipped shapefile readers that number features as Planetiler does.     |
| `hrt-cli`     | The `hrt` program: the build pipeline, `render-dump`, `basemap-test`, `clock` (the archive comparison) and `record`.  |

`hrt-profile` holds thirteen of the fork's fourteen layers: `water`, from OpenStreetMap, Natural Earth and the
prepared ocean polygons; `earth`, from OpenStreetMap, Natural Earth and the prepared land polygons; `boundaries`, from
OpenStreetMap and Natural Earth; `landcover`, from the Daylight landcover GeoPackage and Natural Earth; and `roads`,
`buildings`, `places`, `pois`, `landuse`, `infrastructure`, `facilities`, `trees` and `transit`, from OpenStreetMap.
The Overture sources, the canopy-raster treetops and the Overture-only `districts` layer are not ported. The fork's `transit` layer emits no features. `hrt-cli` carries the parity profile and
the basemap profile the comparisons below use.

`hrt-render`'s `java_math` module translates the fdlibm functions behind Java's `Math.hypot`, `sinh`, `atan` and
`atan2`. On 200,000 inputs, Rust's own `hypot` differed from Java's in the last bit for 26,528 (13%). JTS measures
lengths with `Math.hypot`, and the road smoothing places points with it. A last-bit difference in a smoothed point
changed which vertex Douglas-Peucker kept in 63 of 6,350 Luxembourg road tiles. With the translations, every probe
input matched Java's bits. `Math.cos` remains the platform's, because HotSpot replaces it with an intrinsic. Its result
differed for 456 of the 200,000 inputs; it sets only the smoothing's 6-meter cap, and no tile differed.

`hrt-render` links GEOS, built from source by the `geos` crate's `static` feature, so building it needs cmake and a C++
compiler. GEOS ports the JTS validity test and precision reducer Planetiler calls when a polygon's rounded form is
invalid.

## Checks

```sh
cargo test -p hrt-pmtiles -p hrt-e -p hrt-osm -p hrt-render -p hrt-sort -p hrt-profile -p hrt-sources -p hrt-cli
cargo clippy -p hrt-pmtiles -p hrt-e -p hrt-osm -p hrt-render -p hrt-sort -p hrt-profile -p hrt-sources -p hrt-cli \
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
`hrt-osm` has no counterpart to Planetiler's retry after `buffer(0)`; neither input exercised that retry.

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
line per tile with each layer's feature count and a digest of its features in the form `clock` compares; two archives
that `clock` calls equal give the same record. On 2026-11-02 the Java and `hrt` archives were equal on every tile:

| Input                                          | Tiles | Equal | Byte-identical after gunzip | Features compared |
| ---------------------------------------------- | ----: | ----: | --------------------------: | ----------------: |
| `monaco-latest.osm.pbf`                        |   119 |   119 |                         108 |            35,154 |
| `sf-downtown.osm.pbf`                          |    27 |    27 |                           8 |           203,527 |
| Geofabrik `luxembourg-latest.osm.pbf`, 47.9 MB | 2,079 | 2,079 |                         329 |         4,643,613 |

The tiles that are not byte-identical hold polygons whose rings start at a different vertex, as described above.

Luxembourg also gave a first timing on the lab host (16 cores, load average 1.45 at the start), both builds limited to
four threads. The parity profile writes no attributes and runs no post-processing, so these figures measure reading,
rendering, sorting and encoding; the basemap profile's attribute and merge work adds to both builds:

| Build                                                                 | Wall clock | CPU time | Peak resident memory |
| --------------------------------------------------------------------- | ---------: | -------: | -------------------: |
| Planetiler 0.10.2, `--threads=4`                                      |       30 s |    113 s |         not measured |
| `hrt render-test`, `RAYON_NUM_THREADS=4`, tiles encoded on one thread |     11.6 s |     23 s |               395 MB |
| `hrt render-test`, `RAYON_NUM_THREADS=4`, tiles encoded in parallel   |     10.1 s |     29 s |               534 MB |

The Planetiler figures are its own stage table and exclude JVM start-up; its stages were pass 1 2 s, pass 2 17 s, sort
4 s and archive 7 s. The first `hrt` run used 199% CPU of the four threads because it encoded tiles on one thread. The
second encodes each batch of tiles on rayon's threads and writes them in tile order; it used 285% CPU, and the host's
load average had risen to 18.5 from other jobs by the time it finished, so its CPU time includes contention. These are
single runs on a shared host; the Phase 0 baseline and `hrt titrate` repeat them under controlled load.

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
then to world coordinates, and `hrt` applies the same two formulas; every Monaco and San Francisco tile was equal without
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
takes a zoom from its page-view rank; `LayerDump.java` passes the empty table because the fork's `Pois` throws on a
`wikidata` tag when it has none. A production build reads the gzipped `qrank.csv`, which `basemap-test` takes through `qrank=`.

The `landcover` layer comes from the Daylight landcover GeoPackage through `landcover=`, plus Natural Earth's
Antarctic glaciers. Monaco and Luxembourg lie outside both: with Natural Earth only, both builds write an empty
archive for each. The Daylight path has unit tests and no parity run yet; the GeoPackage is a large download, which
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
reader returns each table's rows in ascending key order, the order geopackage-java hands Planetiler; all 558 Natural
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

Island labels sit at the center of each island's maximum inscribed circle, which GEOS computes with its port of the
JTS algorithm Planetiler calls. These runs do not establish whether either area holds an island polygon, so agreement
between the two implementations on islands is unmeasured.

Both builds write a header zoom range of 0 to 15 whichever zooms hold tiles. The header center differs: Planetiler
writes the middle of the bounds at a zoom fitted to them, and `hrt` writes zoom 0 at 0, 0.
