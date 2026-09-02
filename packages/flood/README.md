# `@mailwoman/flood`

The Environment Agency's **Flood Map for Planning — Flood Zones** (England) as a sealed spatial
layer: acquisition, the `flood.db` build, and the reader that answers what the authority's map
assigns at a coordinate.

Design record: [`docs/superpowers/specs/2026-08-27-flood-layer-survey.md`](../../docs/superpowers/specs/2026-08-27-flood-layer-survey.md).
Contract: [`docs/engineering/reference/layer-contract.mdx`](../../docs/engineering/reference/layer-contract.mdx).

## What it reports, and what it refuses to

Three readings, and keeping them apart is the whole job:

| reading              | what it means                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `designated`         | the authority's map assigns a zone here — `FZ2` or `FZ3`, in the authority's own spelling |
| `designated_absence` | the authority determined here and assigns NO zone. Inside England that IS Flood Zone 1    |
| `unknown`            | no coverage row. Unmapped by this authority, and never a low-hazard reading               |

Readings 2 and 3 are the same empty answer from the geometry and opposite answers from the reader.
Zone 1 is defined by the Planning Practice Guidance as "all land outside Zones 2, 3a and 3b" — an
absence, not a polygon — so inside England a location with no polygon is a designation, while
outside England the same emptiness is unknown. Wales, Scotland and Northern Ireland each have a
different authority and a different zone scheme; Wales's four-zone TAN15 scheme is not
interchangeable with England's.

**Nothing here is a statement about a property.** The layer reports which zone the authority's map
assigns at a location, which is a fact about the map. The EA states that its data is "not suitable
for showing whether an individual property is at risk of flooding", and every reading carries the
product's own exclusions — a Zone 1 answer is silent about surface water, groundwater, sewer
failure and defended-area residual risk.

## The shape of the source, measured

Read over the whole published file (813,627 features, 329,940,166 vertices), because the two design
decisions below rest on it rather than on an impression of what a flood polygon looks like:

| longer bounding-box side | features |  share |
| ------------------------ | -------: | -----: |
| ≤ 0.0001° (~11 m)        |  315,826 | 38.82% |
| ≤ 0.001° (~111 m)        |  163,988 | 20.16% |
| ≤ 0.01° (~1.1 km)        |  214,856 | 26.41% |
| ≤ 0.1° (~11 km)          |  118,855 | 14.61% |
| ≤ 1° (~111 km)           |      102 |  0.01% |

The meter figures are the LATITUDE reading of each degree bound; at 53°N a degree of longitude is
about six tenths of that, so a feature in the first row is under 11 m north-south and under 7 m
east-west.

The largest single feature spans 0.604° (~67 km) and covers 494.7 km²; the widest carries 640,493
vertices. So the product is overwhelmingly tiny slivers with a long tail of river-network polygons,
which is why the index has to handle both ends: a center-containment polyfill loses the first
column entirely, and a fixed fine resolution overruns h3's allocator on the last.

**The rings are stored as `float64` pairs, unsimplified — 16 bytes a vertex, so the geometry tier
is about 5.3 GB before SQLite's own overhead.** That is the size the two-tier contract accepts:
geometry is the truth table, and a rooftop answer at a zone boundary has no cheaper defensible source.
A fixed-point encoding at 1e-7° would halve it, and is deliberately NOT done here — the source
publishes 0.1 mm precision and quantizing to 11 mm is a change to the authority's data, which needs
its own measurement rather than a size argument.

## The two tiers

The authority's **unsimplified rings are the truth table**: a rooftop answer at a zone boundary —
where a flood answer matters most — has no other defensible source. Above them, an **H3 cell table
classifies every cell `whole` or `partial` per zone**: a `whole` cell answers in one primary-key
probe with no geometry read, and only a `partial` cell falls through to a ray cast against the few
polygons `flood_zone_cell_area` already named for it. The whole set is compacted parent-ward, so a
zone's uniform interior collapses to a handful of coarse cells and size concentrates on the fringe,
where it is irreducible.

## Building it

**Prerequisite: the OSGB36 datum grid.** OSGB36 to WGS84 is accurate to a meter only through the
OSTN15 grid; without it PROJ substitutes a ballpark offset, silently. Install it once:

```bash
projsync --area-of-use "United Kingdom"
```

The build refuses to run without it and says so, because the failure is otherwise invisible — see
the trap list below.

```bash
# Measure the partial share at the candidate resolutions and stop. Single-process, so pair it with
# --limit on anything large — see the note below.
mailwoman gazetteer build flood --measure-resolutions 7,8,9 --limit 200000

# The smoke rung: a real artifact over a real prefix of the source.
mailwoman gazetteer build flood --limit 20000 --out /tmp/flood-smoke.db

# The full build, with the two-path agreement check.
mailwoman gazetteer build flood --verify
```

The build acquires the geodatabase itself: the catalogue entry supplies the product's ISO revision
date, the license field and the direct file URL, and the archive is cached per vintage. Pass
`--gdb` to point at an already-unzipped `.gdb`, and `--offline` to skip every network read.

**`--measure-resolutions` is single-process, and a build is the authoritative instrument.** The
measurement compares candidate resolutions in one pass, which means one h3 heap for all of them — and
that heap does not survive the whole file at the finer candidates (see the section below). It
completed at resolution 7 over all 813,627 features and did not at 8 or 9. Use it with `--limit` to
compare candidates on a prefix, and take the number that describes a shipped artifact from the
BUILD's own receipt: `resolveCells` reports exactly the same whole / partial / candidate-pair counts,
and the build is bounded by construction.

## Traps this package exists to have already hit

- **The published `flood_zone` values are `FZ2` and `FZ3`**, not "Flood Zone 2" / "Flood Zone 3".
  The metadata prose describes the column the second way; the shipped geodatabase declares it as a
  3-character string. Measured over the whole file: 540,282 `FZ2`, 273,345 `FZ3`, 813,627 together.
  A builder written against the prose finds nothing.
- **The source is EPSG:27700, not WGS84.** OSGB36 / British National Grid, in meters. Read as
  degrees it lands in the Gulf of Guinea. The ingest asserts the declared authority code and then
  asserts every reprojected vertex against the collection's own declared extent, which is what
  catches a coordinate-order mistake the projection check cannot see.
- **A center-containment polyfill drops most of this product.** The first feature is a 128 m²
  square, and `polygonToCells` returns ZERO cells for it at resolutions 7, 8, 9 and 10 alike. The
  index takes overlapping containment, and a feature that reaches no cell fails the build — a
  dropped feature reads downstream as an absence, which is the one answer this layer must never
  invent.
- **h3's allocator is sized from the bounding box**, so a long meandering river polygon reserves the
  rectangle its meanders span rather than the river. Each feature is indexed at the finest resolution
  whose bounding-box estimate fits the budget, and the resolution it got is stored on the row.
- **`HEAD` returns 405 and `Range` is ignored** on the download host, so a size probe starts a real
  367 MB transfer. Freshness is the catalogue's ISO revision date, never a length probe.
- **A missing datum grid shifts the whole layer, and nothing says so.** With
  `uk_os_OSTN15_NTv2_OSGBtoETRS.tif` absent, ogr2ogr placed the first feature's first vertex at
  `1.698151293, 52.648130027`; with the grid installed it placed it at `1.698174628, 52.648157259` —
  3.4 m apart. Both are ordinary WGS84 coordinates and both pass a bounding-box check. It surfaced
  only in the two-path agreement check, as 8 disagreements out of 59 against the authority's own OGC
  service, every one a point that had fallen into a neighboring sliver: at this product's scale
  3 m changes the answer, because 38.8% of its polygons are under 11 m across. With the grid
  installed the same check reads **59/59**. `--config PROJ_NETWORK ON` does not reach PROJ through
  GDAL 3.8 and `PROJ_ONLY_BEST=ON` was observed not to refuse, so the build asks `projinfo` what PROJ
  would choose and stops when the answer is a ballpark.

## The index resolution, and what the measurement decided

Three full builds over all 813,627 polygons. Every column is from the build's own receipt.

| res | whole cells (compacted) | partial cells | partial share | candidate `(cell, area)` pairs | candidates per ray cast | sealed artifact |
| --: | ----------------------: | ------------: | ------------: | -----------------------------: | ----------------------: | --------------: |
|   7 |                      75 |        50,187 |         99.8% |                        986,219 |                    19.7 |   (measurement) |
|   8 |                   1,207 |       205,049 |         99.4% |                      1,310,706 |                     6.4 | 5,776,105,472 B |
|   9 |                  18,037 |       766,114 |         97.7% |                      2,330,261 |                     3.0 | 5,814,308,864 B |

**Resolution 9, and the number that decided it is not the one the survey expected.**

The `partial` share barely moves — 99.8% to 99.4% to 97.7% across three resolutions. That is not a
property of the index; it is the polygon size distribution showing through. 38.8% of this product's
features are under 11 m across, so they are `partial` at every resolution a national layer could
use, and no resolution choice can change that. **Choosing on the `partial` share would have been
choosing on a constant.**

What does move is the size of the candidate list a `partial` cell hands to the ray cast: 19.7
polygons at resolution 7, 6.4 at 8, 3.0 at 9. That is the runtime cost the two-tier design exists to
bound, and it improves by 6.5× from 7 to 9.

The price is 38 MB — resolution 9's artifact is **0.66% larger** than resolution 8's, because the
index tier is small against 5.5 GB of geometry either way. Six times the ray-cast work saved for
two-thirds of one percent of the artifact is not a close call.

Resolution 7 is excluded outright: 75 whole cells over the whole of England means the index
summarizes essentially nothing.

## What the full build produces

- **813,627 polygons** — 540,282 `FZ2`, 273,345 `FZ3`, matching the source's own distribution exactly.
- **18,037 whole cells** after compaction, at resolutions 6/7/8/9; **766,114 partial**; 2,330,261
  candidate pairs. No feature needed coarsening.
- **3,464 coverage cells** at resolution 6, all `designated` at completeness 1.0.
- **17,766.2 km²** of mapped flood zone against the source's own 17,830.1 km² — 0.359% apart. Read
  without their holes the same rings total 19,399.1 km², so a hole-blind reader would have claimed
  **9.2% more ground than the authority mapped**.
- **5,814,308,864 bytes** sealed at 0444.

Verification against the authority's own OGC API Features service, on 58 sampled points: **57 agree,
1 within boundary tolerance, 0 disagree**. The tolerated point sits **9 mm** from the service's own
edge, where a six-decimal rendering and a nine-decimal one fall on opposite sides. The negative half:
**8/8 points outside England read `unknown`**, none read a zone.

## The h3 heap runs out, and it fails by returning nothing

The finding every polygon builder on this spine inherits, stated with what it cost here.

**The mechanism.** h3's WASM heap cannot be reset from JavaScript, and it does not survive an
unbounded number of `polygonToCells` calls. h3-js frees every buffer it allocates, so what
accumulates is fragmentation across millions of interleaved tiny and large allocations. What makes it
dangerous is HOW it fails: `polygonToCellsExperimental` sizes its output with `_calloc`, a failing
`_calloc` returns the null pointer, and in WASM address zero is ordinary writable memory — so the
call reports success and the reader hands back an array of zeros. **An exhausted allocator answers
"no cells" rather than raising an error.**

**What it cost.** Three single-process runs over this product died at feature 510994 — 164 m², 23
parts, 130 vertices — after roughly 510,000 others; it classifies in 35 ms at every resolution 9
through 4 in a fresh process. A fourth died at feature 798284 after 798,000. Both are ordinary
features. Neither failure is a property of the geometry.

**The invariant, and where it lives.** A part with a non-degenerate bounding box touches at least one
cell, so zero is not an answer it can have. `classifyFeatureCells` checks that **per part**, not per
feature: a per-feature check passes any multi-part feature whose other parts answered, and indexes it
short with no error anywhere — the silent-absence shape this layer exists to refuse.

**The build does not rely on staying under the ceiling.** The classification runs in bounded child
processes, one per range of the authority's own feature ids (`--chunk-size`, default 100,000 against
a measured ceiling five times larger), so every chunk gets a heap that starts empty. The
call-removal shortcuts — a part inside one cell, a part too narrow to contain one — make the build
faster and are **not** what makes it correct. A build that completed only when fragmentation happened
to stay low would not be reproducible.

**Both live in `@mailwoman/spatial`, not here.** `classifyFeatureCells`, the zero-cell guard and the
ring blob under it are properties of h3-js and of byte layout rather than of this product, and
`@mailwoman/soil` needs them unchanged — so they moved, and `sdk/cells.ts` and `rings.ts` re-export
them. What stays in this package is what is zone-shaped: `FloodCellIndex` accumulates per zone code,
because the question asked of this layer is about the ZONE.

## License

The layer ships at `tier: shipped` because OGL v3.0 permits redistribution with a named
acknowledgement. The attribution string is the license condition, not decoration, and rides in
`layer_manifest.attribution`:

> © Environment Agency copyright and/or database right 2025. All rights reserved.

The footprint is clipped to an ONS Open Geography country boundary — the EA states its mapping
covers all of England and does not publish where England is — which carries its own OGL attribution,
recorded in `flood_map_extent`:

> Contains National Statistics data © Crown copyright and database right 2025. Contains OS data ©
> Crown copyright and database right 2025.

## Publish posture

`@mailwoman/flood` is a **brand-new npm name** and is deliberately absent from `.release-it.json`'s
publish list, recorded as data in `SANCTIONED_RELEASE_ABSENCES`. npm Trusted Publishing cannot
create a package that does not exist, so the name needs the `bless-package` first publish before it
may enter the release list; joining it early fails the whole release at this workspace with a bare
`E404`. See [`RELEASING.md`](../../RELEASING.md).
