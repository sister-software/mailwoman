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

The other crates the specification names (`hrt-osm`, `hrt-render`, `hrt-sort`, `hrt-profile`, `hrt-cli`) are not
written yet.

## Checks

```sh
cargo test -p hrt-pmtiles -p hrt-e
cargo clippy -p hrt-pmtiles -p hrt-e --all-targets -- -D warnings
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
