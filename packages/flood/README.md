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

| bounding-box side | features | share |
| ----------------- | -------: | ----: |
| ≤ 11 m            |  315,826 | 38.8% |
| ≤ 111 m           |  163,988 | 20.2% |
| ≤ 1.1 km          |  214,856 | 26.4% |
| ≤ 11 km           |  118,855 | 14.6% |
| ≤ 111 km          |      102 | 0.01% |

The largest single feature spans 0.604° (~67 km) and covers 494.7 km²; the widest carries 640,493
vertices. So the product is overwhelmingly tiny slivers with a long tail of river-network polygons,
which is why the index has to handle both ends: a centre-containment polyfill loses the first
column entirely, and a fixed fine resolution overruns h3's allocator on the last.

**The rings are stored as `float64` pairs, unsimplified — 16 bytes a vertex, so the geometry tier
is about 5.3 GB before SQLite's own overhead.** That is the size the two-tier contract accepts:
geometry is the truth table, and a rooftop answer at a zone boundary has no cheaper honest source.
A fixed-point encoding at 1e-7° would halve it, and is deliberately NOT done here — the source
publishes 0.1 mm precision and quantizing to 11 mm is a change to the authority's data, which needs
its own measurement rather than a size argument.

## The two tiers

The authority's **unsimplified rings are the truth table**: a rooftop answer at a zone boundary —
where a flood answer matters most — has no other honest source. Above them, an **H3 cell table
classifies every cell `whole` or `partial` per zone**: a `whole` cell answers in one primary-key
probe with no geometry read, and only a `partial` cell falls through to a ray cast against the few
polygons `flood_zone_cell_area` already named for it. The whole set is compacted parent-ward, so a
zone's uniform interior collapses to a handful of coarse cells and size concentrates on the fringe,
where it is irreducible.

## Building it

**Prerequisite: the OSGB36 datum grid.** OSGB36 to WGS84 is accurate to a metre only through the
OSTN15 grid; without it PROJ substitutes a ballpark offset, silently. Install it once:

```bash
projsync --area-of-use "United Kingdom"
```

The build refuses to run without it and says so, because the failure is otherwise invisible — see
the trap list below.

```bash
# Measure the partial share at the candidate resolutions and stop.
mailwoman gazetteer build flood --measure-resolutions 7,8,9

# The smoke rung: a real artifact over a real prefix of the source.
mailwoman gazetteer build flood --limit 20000 --out /tmp/flood-smoke.db

# The full build, with the two-path agreement check.
mailwoman gazetteer build flood --verify
```

The build acquires the geodatabase itself: the catalogue entry supplies the product's ISO revision
date, the licence field and the direct file URL, and the archive is cached per vintage. Pass
`--gdb` to point at an already-unzipped `.gdb`, and `--offline` to skip every network read.

## Traps this package exists to have already hit

- **The published `flood_zone` values are `FZ2` and `FZ3`**, not "Flood Zone 2" / "Flood Zone 3".
  The metadata prose describes the column the second way; the shipped geodatabase declares it as a
  3-character string. Measured over the whole file: 540,282 `FZ2`, 273,345 `FZ3`, 813,627 together.
  A builder written against the prose finds nothing.
- **The source is EPSG:27700, not WGS84.** OSGB36 / British National Grid, in metres. Read as
  degrees it lands in the Gulf of Guinea. The ingest asserts the declared authority code and then
  asserts every reprojected vertex against the collection's own declared extent, which is what
  catches a coordinate-order mistake the projection check cannot see.
- **A centre-containment polyfill drops most of this product.** The first feature is a 128 m²
  square, and `polygonToCells` returns ZERO cells for it at resolutions 7, 8, 9 and 10 alike. The
  index takes overlapping containment, and a feature that reaches no cell fails the build — a
  dropped feature reads downstream as an absence, which is the one answer this layer must never
  invent.
- **h3's allocator is sized from the bounding box**, so asking for resolution 9 over a long
  meandering river polygon threw `Memory allocation failed (code: 13)` out of the WASM heap after
  350,000 features. Each feature is indexed at the finest resolution whose bounding-box estimate
  fits the budget, and the resolution it got is stored on the row.
- **`HEAD` returns 405 and `Range` is ignored** on the download host, so a size probe starts a real
  367 MB transfer. Freshness is the catalogue's ISO revision date, never a length probe.
- **A missing datum grid shifts the whole layer, and nothing says so.** With
  `uk_os_OSTN15_NTv2_OSGBtoETRS.tif` absent, ogr2ogr placed the first feature's first vertex at
  `1.698151293, 52.648130027`; with the grid installed it placed it at `1.698174628, 52.648157259` —
  3.4 m apart. Both are ordinary WGS84 coordinates and both pass a bounding-box check. It surfaced
  only in the two-path agreement check, as 8 disagreements out of 59 against the authority's own OGC
  service, every one a point that had fallen into a neighbouring sliver: at this product's scale
  3 m changes the answer, because 38.8% of its polygons are under 11 m across. With the grid
  installed the same check reads **59/59**. `--config PROJ_NETWORK ON` does not reach PROJ through
  GDAL 3.8 and `PROJ_ONLY_BEST=ON` was observed not to refuse, so the build asks `projinfo` what PROJ
  would choose and stops when the answer is a ballpark.

## Licence

The layer ships at `tier: shipped` because OGL v3.0 permits redistribution with a named
acknowledgement. The attribution string is the licence condition, not decoration, and rides in
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
