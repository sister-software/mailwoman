# `@mailwoman/zoning`

Ireland's **Generalised Zoning Types** as a sealed spatial layer: what a local authority's adopted plan
assigns at a coordinate, in that authority's own vocabulary, with the plan it belongs to and that plan's
stated window.

Published by the Department of Housing, Local Government and Heritage for the MyPlan.ie project, covering
**30 of the Republic's 31 local authorities**. The one absent is Donegal County Council. Against Census 2022
(CSO table `FY003A`), **4,982,055 of 5,149,139 residents — 96.76% — live in a local authority whose zoning is
represented in the layer.** That is a jurisdiction statement and nothing more: living in a covered authority
is not the same as having a zoning polygon at your address.

**The artifact is built locally and never redistributed.** Three published statements disagree about the
source's license, so the manifest carries `tier: build-local` and `license: NOASSERTION`, and the builder
refuses a `shipped` tier until that is resolved in writing. See _Licence and posture_ below.

## What it reports, and what it refuses to

Two readings, and the one that is missing is the point.

| reading      | what it means                                                                              |
| ------------ | ------------------------------------------------------------------------------------------ |
| `designated` | An adopted plan places the location inside a zoning polygon, and the polygon is the answer |
| `unknown`    | No zoning polygon contains the point. **Not an absence reading, and this layer has none**  |

**There is no `designated_absence` here, and zoning is the hardest case of the rule.** For flood zones the
Environment Agency states England-wide coverage and the Planning Practice Guidance defines Zone 1 as the land
outside Zones 2 and 3, so an empty answer inside England IS a designation. No such definition exists anywhere
for zoning. A location with no zoning polygon is one of at least four different things:

1. Outside any adopted plan area — most land in most countries. The authority has said nothing.
2. Inside a plan area, on land the plan does not zone.
3. In a jurisdiction that has never adopted zoning at all.
4. In a jurisdiction whose records nobody has read or published yet.

**And the source can state one of them positively, which is what proves the rest are absences.** It carries
`ZONE_ORIG = "UNZ - Unzoned"` with `ZONE_GZT = "N/A"` on 4 of its 85,330 rows. Where the authority means
unzoned it says so on a row; every other absence is a row that is not there.

So every `layer_coverage` row carries `basis = source_present`, the reader refuses to OPEN an artifact
carrying anything stronger, and the observation stays silent where no polygon contains the point.

**Neither reading is a statement about what may be built.** The Department states that its data are "not
published here as legal definitions of the current actuality with regard to Local Authority zoning or their
geographic extents" and that "Original data should be sourced directly from the relevant Local Authority".
Those exclusions ride on every reading.

## The vocabulary decision — the verbatim code, and the crosswalk beside it

This is the layer's distinctive contract, and Ireland is a natural experiment on it: a national authority
already built the crosswalk, over one small country, with statutory access to the plans.

Measured over the whole national export:

| measurement                                                     |   value |
| --------------------------------------------------------------- | ------: |
| distinct local zone strings (`ZONE_ORIG`) across 30 authorities | **581** |
| the same, trimmed and case-folded                               | **555** |
| distinct national generic types (`ZONE_GZT`) observed           |  **55** |
| generic types the service's own coded-value domain DECLARES     |  **54** |
| distinct `(authority, local code)` pairs                        | **795** |
| **pairs taking MORE THAN ONE generic type**                     |  **52** |

**The decisive one is the last.** If a local code determined a generic type, the mapping could ship as a
lookup and the local column would be redundant. It does not: Cork County Council's `Special Policy Area` takes
**14** different generic types, its `Green Infrastructure` **12**, and Clare's `Utilities` **11**. The mapping
is per polygon, authored by a person reading a plan, and it cannot be reconstructed from the pair of columns.

So `zoning_area` carries **both**, and `zoning_crosswalk_edge` ships **empty** — checked rather than assumed:
`assertCrosswalkIsNotATable` refuses a build that would write an edge while any pair is non-functional.

The Department says the same thing in its own words, in the item description:

> This represents a consistent zoning scheme across all local authorities, and **complements (rather than
> replaces) the existing statutory zoning used for each individual plan**.

**The declared domain is closed and the source already breaks it.** 54 declared against 55 used: `N/A` appears
on 4 rows and in no domain. So `zoning_vocabulary` carries the declared domain **plus** the values observed in
the data, with `declared` separating them — folding the two would either hide a source-schema change or invent
a declaration the Department never made. A declared code the data never uses is kept at `observed_rows = 0`
for the same reason: `SDZ` is a real plan level nobody has used yet.

## Three measured source behaviors a builder has to know

### Hole roles come from ring ORIENTATION, and clockwise is the exterior

The inverse of RFC 7946's convention, and the one thing about this source that produces a well-formed wrong
answer in silence. Measured over the whole national export (85,330 features, 93,483 rings):

| reading                                                    |         km² |
| ---------------------------------------------------------- | ----------: |
| sum of signed ring areas, in the source's own ITM meters   | **5,444.5** |
| the Department's own `Shape__Area` sum                     | **5,444.5** |
| sum of ABSOLUTE ring areas, in the source's own ITM meters | **5,666.6** |

**Read in the source's own projection the signed sum matches the publisher to eight decimal places**
(5,444,492,956.43 m² against 5,444,492,956.40) — which is what settles the convention. The BUILD compares a
spherical reading of the reprojected rings, so its own numbers sit a few tenths of a percent away from both:
5,423.2 km² with holes against the publisher's 5,444.5 (**0.392% apart**), and 5,644.4 km² without them
(**3.7% away**). That gap between the two readings is the signal, and the 1% build tolerance sits between them
with room on each side — Irish Transverse Mercator's scale factor and a spherical approximation together
contribute a few tenths of a percent, and hole-blindness contributes ten times that.

89,967 rings are clockwise and 3,516 counter-clockwise; 1,309 features carry both windings. Of those, 1,210
nest their holes inside one polygon part the way RFC 7946 expects and the rest put every ring in its own
`MultiPolygon` part — the largest feature in the country, Meath's `RA - Rural Area`, arrives as 107 single-ring
parts of which 5 are clockwise and 102 counter-clockwise. **Both encodings reach the ingest, and the
orientation is the only signal that means the same thing in both.**

**Two residuals, both measured and both carried rather than refused.** Nine of the 3,516 holes share their
parent's boundary rather than sitting inside it — every one a sliver under 1.7 m² — and go to the smallest
exterior of their own feature, which on eight of the nine is the only exterior there is. And **exactly one
feature of 85,330** has no ring the rule can read as an exterior at all: `OBJECTID` 74040, Galway County
Council's `Agriculture`, a three-vertex ring enclosing 3.0 × 10⁻⁷ m². At that magnitude a ring's winding is
floating-point noise rather than something the publisher stated — it reads clockwise in the source's own Irish
Transverse Mercator meters and counter-clockwise after reprojection — so the largest ring by magnitude becomes
the exterior, which is also the correct reading for a feature published wholly inverted. Both counts ride on
the build receipt rather than being implied to be zero.

The area error is 4.1% and is the harmless half. The harmful half is that a ray cast treating all 107 rings as
exteriors answers "inside `P5` rural zoning" for every location the plan carved out.

**GDAL cannot be asked to preserve this**, which is why the ingest streams WKT rather than GeoJSON. Its GeoJSON
writer enforces the RFC 7946 winding unconditionally — `-lco RFC7946=NO` is not a GeoJSONSeq option and
`--config OGR_ORGANIZE_POLYGONS SKIP` changes nothing — so through GeoJSONSeq the Meath feature arrives as 107
counter-clockwise exteriors totalling 2,371.9 km² against the Department's 2,232.1 km². The same conversion
written as CSV/WKT keeps the source's 5/102 split intact.

### The publisher's own area column is not in the archive

`Shape__Area` is a service field and the bulk GeoJSON export drops it, so the area cross-check reads it from the
live service instead — which is what makes it a two-path check rather than the archive agreeing with
itself. Measured: 5,444,492,956.40 m² over 85,330 features.

### The definition host has no DNS record

All 85,330 rows link their generic type's definition to `viewer.myplan.ie`, which has no A or AAAA record, and
three candidate replacements on the live host answer HTTP 404. The 54 code-to-label pairs survive in the
service's own coded-value domain; the **definitions** behind them do not. So `zoning_vocabulary.definition_url`
is NULL on every row rather than filled with a plausible one.

### And two acquisition behaviors

- The Hub download job answers `{"status":"Completed","resultUrl":…}` in 249 bytes, and the result URL **302s**
  — the transfer follows redirects, and a client that took the first response as the file would write a
  redirect page to disk and report a successful download.
- The bulk export is **EPSG:2157** (IRENET95 / Irish Transverse Mercator) declared in a top-level `crs` member
  RFC 7946 removed from the format. GDAL honours the legacy member; a strict reader ignores it and places
  Ireland's zoning at latitude 735,435. The ingest asserts the source's declared authority code before reading
  a feature, and asserts every reprojected vertex inside the Department's own declared extent.

## The two tiers

`zoning_area` holds the authority's **unsimplified** rings with their hole roles resolved, plus a precomputed
bounding box; `zoning_cell` is an H3 containment index above it, `WITHOUT ROWID`, keyed `(h3_cell, area_id)`.
A probe walks the index first and reaches the geometry only for a cell a boundary crosses.

**The index is cell-touches-polygon, never cell-center-in-polygon**, and a feature that reaches no cell fails
the build. That is not a preference: `polygonToCells` — the polyfill a builder reaches for first — returns
nothing at all for most of these polygons, and every dropped polygon would read downstream as an absence of
zoning at exactly the question this layer exists to answer.

`zoning_cell` rows are **mixed-resolution**: each feature's whole tier is compacted parent-ward, so a row
carries its own `resolution` and a probe walks its own `cellToParent` chain over every resolution the table
holds. `layer_coverage` stays single-resolution.

## The resolution is a measurement, and NOT the one the size contract names

The inherited size contract picks a resolution from the measured `partial` share. **For this subject that
statistic carries no signal**, and the reason was measured. Zoning polygons are mostly smaller than a cell:

| percentile |  p1 |  p5 | p10 |   p25 |   **p50** |    p75 |    p90 |    p95 |     p99 |
| ---------- | --: | --: | --: | ----: | --------: | -----: | -----: | -----: | ------: |
| area (m²)  |   9 | 132 | 317 | 1,258 | **4,497** | 14,991 | 44,432 | 89,755 | 486,787 |

Against H3 average cell areas (h3-js 4.5.0): res 9 = 105,333 m², res 10 = 15,048 m², res 11 = 2,150 m².
**95.7% of zoning polygons are smaller than an average res-9 cell**, 75.1% smaller than a res-10 cell and
34.5% smaller than a res-11 cell — so the `partial` share sits near 100% at every candidate and cannot choose
between them.

Two numbers can, and both are measured over the FULL national set by
`mailwoman gazetteer build zoning --measure-resolutions 9,10,11`:

| res    | features | polyfill-only zero-cell | stored cell rows | touched cells | candidates/cell mean |   p90 | max | cells >1 candidate | partial share | coarsened |
| ------ | -------: | ----------------------: | ---------------: | ------------: | -------------------: | ----: | --: | -----------------: | ------------: | --------: |
| 9      |   85,330 |          73,068 (85.6%) |           48,882 |        68,184 |                 3.39 |     9 |  90 |     28,056 (41.1%) |         58.0% |         0 |
| **10** |   85,330 |          48,412 (56.7%) |          237,411 |       426,993 |             **1.69** | **3** |  55 |    121,884 (28.5%) |         40.6% |         0 |
| 11     |   85,330 |          19,224 (22.5%) |        1,121,461 |     1,897,777 |                 1.32 |     2 |  23 |    432,969 (22.8%) |         37.0% |         1 |

**Resolution 10, chosen from those numbers.** Going from 9 to 10 takes the p90 candidate count from 9 to 3 — a
threefold reduction in the geometry a fringe probe reads — for 4.9× the stored rows. Going on from 10 to 11 buys
p90 3 → 2 for another 4.7× the rows. The knee is at 10, and the `partial` share (58.0 / 40.6 / 37.0%) has no
knee at all, which is the measurement that says it is the wrong column to choose on.

**The left-hand column is the finding, and it is a defect waiting to happen.** At resolution 9, `polygonToCells`
returns nothing at all for **73,068 of 85,330 polygons — 85.6%** — because no cell center falls inside them. A
builder that indexed only the polyfill output would silently drop six of every seven zoning polygons, and every
dropped polygon would read downstream as "no zoning here". Even at resolution 11 it drops 22.5%. The survey
measured 86.8% on one urban authority; the national figure is 85.6%, measured rather than extrapolated.

This index's own zero-cell count is **0 at every resolution**, by construction: `classifyFeatureCells` takes
overlapping containment and throws on a feature that reaches no cell. One feature (Meath's 2,232 km² rural zone)
is indexed coarser than 11 by the allocator budget, which is why the `coarsened` column reads 1 there.

## The build, as it ran

The full national build on this lab, at the chosen resolution 10 with coverage at res 6:

| what                | measured                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| acquisition         | 247,452,342 bytes in 42.0 s, one anonymous request following the Hub job's redirect                                           |
| features            | **85,330** — the archive, the service's `returnCountOnly` and the build all agree                                             |
| authorities / plans | **30** local authorities, **63** plans                                                                                        |
| rings               | 93,483 total · 89,967 exterior · 3,516 hole · 3,507 holes nested · **9** on a parent's boundary · **1** exterior by magnitude |
| cells               | 64,273 whole (compacted) + 465,702 partial = **529,975** rows, at resolutions 6/7/8/9/10 · 0 features coarsened               |
| coverage            | **1,161** cells at res 6, every one `source_present`                                                                          |
| area                | publisher **5,444.5 km²** · rings with holes 5,423.2 km² (0.392% apart) · rings without holes 5,644.4 km²                     |
| vocabulary          | `IE-GZT` 55 codes, **1 undeclared** (`N/A`) · 30 `IE-LOCAL:*` schemes · `IE-SZO` 21 · `IE-PLAN-LEVEL` 3                       |
| crosswalk           | **795** (authority, local code) pairs, **52** taking more than one generic type · `zoning_crosswalk_edge` empty               |
| artifact            | 174,678,016 bytes, sealed 0444                                                                                                |
| verify (positive)   | **48/48 agree** with the live service · 0 within boundary tolerance · 0 disagree · 0 local-code mismatches                    |
| verify (negative)   | **6/6** Donegal and Northern Irish points read `unknown` with no designation                                                  |

## Building it

```bash
# The whole country. Downloads the 247 MB export on the first run and caches it under its vintage.
mailwoman gazetteer build zoning

# The smoke rung: one local authority over the real export.
mailwoman gazetteer build zoning --export <path> --authority SD

# The measurement, which builds nothing.
mailwoman gazetteer build zoning --export <path> --measure-resolutions 9,10,11 --offline
```

The build is **batched**: one child process per range of the authority's own feature ids, because h3's WASM
heap cannot be reset from JavaScript and does not survive an unbounded number of polyfill calls. This product's
85,330 features fit inside the 100,000-id default, and the bound ships anyway — a build that stays inside a
ceiling by luck is not the same fact as one that cannot cross it.

## Verification

`--verify` runs both halves against the Department's own feature service.

**Positive half.** A deterministic sample of interior points, spread across authorities, answered from the
sealed artifact and then re-asked of the live service. The service's rings get the SAME hole-role resolution
the ingest gave the archive's, so what is compared is a verdict against a verdict. A point within half a meter
of a service-polygon edge is reported as `boundary_tolerance` rather than as a disagreement, with its distance
**to the nearest edge** — a point a centimeter from a long edge can be meters from every vertex of it.

**Negative half, and it matters more here than for any sibling layer.** Donegal points and Northern Irish
points must come back `unknown` with no designation. A positive-only check would pass on an artifact that
reported the whole island as zoned.

## License and posture

**Three published statements disagree about the grant**, all read 2026-08-27:

1. `data.gov.ie` declares `license_id: "CC-BY-4.0"`.
2. The ArcGIS item's `licenseInfo` says the Department "aims to publish its data holdings into the future,
   **where possible**, as Open Data licensed under Creative Commons Attribution 4.0" and, in the same field,
   that copyright "belonging to our licensors (**Tailte Éireann**) may not be copied, transmitted or reproduced
   without their prior consent. … © Tailte Éireann. All rights reserved. License No. 2023/OSi_NMA_073".
3. `myplan.ie`'s own disclaimer grants distribution and commercial use, and points at a map-viewer splash
   screen for the operative terms.

A shipped layer needs one grant it can quote, and this record does not have one. So:

- `layer_manifest.license` is **`NOASSERTION`** — SPDX's own token for a determination nobody has made. Writing
  `CC-BY-4.0` there while an all-rights-reserved clause names a licensor would be this program asserting a
  grant.
- `layer_manifest.tier` is **`build-local`**, and `assertTierMatchesLicense` refuses a `shipped` build while the
  license reads `NOASSERTION`. Moving the tier takes a deliberate edit at a line that names what is unresolved.
- `layer_manifest.attribution` carries **both halves** — the Department's credit line and the Tailte Éireann
  clause — because a re-user who saw only the first would not know the second exists.

**What would change it:** the myplan.ie disclaimer names a fourth statement as authoritative ("For full details
of conditions of use please see map viewer splash screen"), and that splash text was not retrieved. Two ArcGIS
instant-app configurations linked from the viewer page were read and neither is the zoning viewer's. That is
the single fact that would move this layer from `build-local` to `shipped`.

**And the npm hold is separate.** `@mailwoman/zoning` is a brand-new npm name awaiting its `bless-package`
first publish, which Trusted Publishing cannot perform from CI — so the workspace is held out of
`.release-it.json` with its reason recorded as data in `SANCTIONED_RELEASE_ABSENCES`
(`scripts/release-stage.ts`). Resolving either hold does not resolve the other.

## The mapped-footprint question — what is settled, and what would change it

`zoning_mapped_extent` ships **empty**, and its emptiness is the claim. The Department states "Awaiting data for
some Local Authorities - please see map viewer for coverage details" and publishes that detail only inside a map
application. Donegal's absence was recovered by measuring `LA_CODE`, not read from a coverage statement, and
whether other authorities are partially rather than wholly represented is unknown.

**Deriving a footprint from the union of the zoning polygons is forbidden**, for the same reason the flood layer
forbids it: the union of zoned areas is not the area the authority examined, and the difference is the whole
content of a negative answer. It is not even a stable shape here — one authority's drafting convention moves the
national zoned-area figure by 41%, because Meath County Council zones its entire rural remainder as one 2,232 km²
polygon against 32.5 km² for the next largest in the country.

What would move this layer from `source_present` to a stronger basis is a published statement of the area the
Department MAPPED, plus its geometry.

## Consumer

`packages/mailwoman/lib/observations/zoning-route.ts` reads a finished coordinate and records what an adopted plan
assigns there, as one additive `authority_designation` marker with `mechanism: layer:zoning`. **Default off, and
the switch is the presence of `$MAILWOMAN_DATA_ROOT/zoning/zoning-ireland.db`** rather than a boolean. No layer
file, no route, and the geocode result is byte-identical to a build without the field.

## See also

- The survey that produced this layer: `docs/superpowers/specs/2026-08-27-zoning-layer-survey.md`
- The layer contract: `docs/engineering/reference/layer-contract.mdx`
- The runtime-flag register: `docs/engineering/reference/runtime-flags.mdx`
