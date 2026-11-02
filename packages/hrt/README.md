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

| Crate         | What it does                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `hrt-pmtiles` | PMTiles v3 writing: Hilbert tile ids, the header, directory encoding with leaf directories, and tile deduplication. |
| `hrt-e`       | Mapbox Vector Tile encoding: layers with interned keys and values, and zig-zag delta geometry commands.             |
| `hrt-osm`     | OpenStreetMap reading in Planetiler's two passes: packed node locations, way geometry and multipolygon assembly.    |
| `hrt-render`  | Planetiler's renderer: simplification, stripe clipping into tiles, polygon snapping, and MVT command encoding.      |

The other crates the specification names (`hrt-sort`, `hrt-profile`, `hrt-cli`) are not written yet.

`hrt-render` links GEOS, built from source by the `geos` crate's `static` feature, so building it needs cmake and a C++
compiler. GEOS ports the JTS validity test and precision reducer Planetiler calls when a polygon's rounded form is
invalid.

## Checks

```sh
cargo test -p hrt-pmtiles -p hrt-e -p hrt-osm -p hrt-render
cargo clippy -p hrt-pmtiles -p hrt-e -p hrt-osm -p hrt-render --all-targets -- -D warnings
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
line layer, with Planetiler's default sizes, tolerances and buffers at zooms 0 to 14. `hrt-render`'s `render-dump`
example runs the same profile over `hrt-osm`:

```sh
java -cp protomaps-basemap-HEAD-with-deps.jar packages/hrt/parity/RenderDump.java input.osm.pbf scratch/ > java.txt
cargo run --release -p hrt-render --example render-dump -- input.osm.pbf > rust.txt
```

On 2026-11-02 the sorted outputs compared as follows:

| Input                   | Tile pieces | Identical | Ring start rotated | Polygons sent to the precision reducer |
| ----------------------- | ----------: | --------: | -----------------: | -------------------------------------: |
| `monaco-latest.osm.pbf` |      80,483 |    80,441 |                 42 |                                     42 |
| `sf-downtown.osm.pbf`   |     338,329 |   338,075 |                254 |                                    256 |

Every differing piece has the same rings, the same vertices and the same signed ring areas as Planetiler's. The
precision reducer in GEOS starts some rings at a different vertex from the JTS one, which encodes the same polygon with
different commands. The archive comparison tool therefore compares polygon rings up to rotation.
