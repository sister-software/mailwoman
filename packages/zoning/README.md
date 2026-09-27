# `@mailwoman/zoning`

This package provides Ireland's **Generalised Zoning Types** as a sealed spatial layer. The layer reports
what a local authority's adopted plan assigns at a coordinate, in that authority's own vocabulary, together
with the plan and that plan's stated window.

The Department of Housing, Local Government and Heritage publishes the data for the MyPlan.ie project. It
covers **30 of the Republic's 31 local authorities**, and Donegal County Council is the one missing. Against
Census 2022 (CSO table `FY003A`), **4,982,055 of 5,149,139 residents (96.76%) live in a local authority whose
zoning is represented in the layer.** That figure describes jurisdictions only. Living in a covered authority
does not mean that a zoning polygon covers your address.

**The artifact is built locally and never redistributed.** Three published statements disagree about the
source's license, so the manifest carries `tier: build-local` and `license: NOASSERTION`. The builder refuses
a `shipped` tier until the license question is resolved in writing. See _Licence and posture_ below.

## What it reports, and what it refuses to

The layer has two readings. The reading it lacks matters most.

| reading      | what it means                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `designated` | An adopted plan places the location inside a zoning polygon, and the polygon is the answer                       |
| `unknown`    | No zoning polygon contains the point. This reading does not claim absence, and this layer has no absence reading |

**This layer has no `designated_absence` reading, and zoning is the hardest case of this rule.** For flood
zones the Environment Agency states England-wide coverage, and the Planning Practice Guidance defines Zone 1
as the land outside Zones 2 and 3, so an empty flood answer inside England is a designation. Zoning has no
such definition anywhere. A location with no zoning polygon can be in at least four different situations:

1. Outside any adopted plan area, which covers most land in most countries. The authority has made no statement.
2. Inside a plan area, on land the plan does not zone.
3. In a jurisdiction that has never adopted zoning at all.
4. In a jurisdiction whose records nobody has read or published yet.

**The source states one of these cases explicitly, which shows that the other cases are absences.** It
carries `ZONE_ORIG = "UNZ - Unzoned"` with `ZONE_GZT = "N/A"` on 4 of its 85,330 rows. When the authority
means unzoned, it writes that on a row. Every other absence is a missing row.

Every `layer_coverage` row therefore carries `basis = source_present`. The reader refuses to open an artifact
that carries anything stronger, and the observation stays silent where no polygon contains the point.

**Neither reading states what may be built.** The Department states that its data are "not published here as
legal definitions of the current actuality with regard to Local Authority zoning or their geographic extents"
and that "Original data should be sourced directly from the relevant Local Authority". Every reading carries
those exclusions.

## The vocabulary decision — the verbatim code, and the crosswalk beside it

The crosswalk design is what distinguishes this layer. Ireland provides a natural test of it, because a
national authority has already built a crosswalk for one small country with statutory access to the plans.

These figures cover the whole national export:

| measurement                                                     |   value |
| --------------------------------------------------------------- | ------: |
| distinct local zone strings (`ZONE_ORIG`) across 30 authorities | **581** |
| the same, trimmed and case-folded                               | **555** |
| distinct national generic types (`ZONE_GZT`) observed           |  **55** |
| generic types the service's own coded-value domain declares     |  **54** |
| distinct `(authority, local code)` pairs                        | **795** |
| **pairs taking more than one generic type**                     |  **52** |

**The last figure decides the design.** If a local code determined a generic type, the mapping could ship as
a lookup and the local column would be redundant. A local code does not determine the type. Cork County
Council's `Special Policy Area` takes **14** different generic types, its `Green Infrastructure` takes **12**,
and Clare's `Utilities` takes **11**. A person assigned the mapping per polygon while reading a plan, and it
cannot be reconstructed from the pair of columns.

`zoning_area` therefore carries **both** columns, and `zoning_crosswalk_edge` ships **empty**. Code checks
this: `assertCrosswalkIsNotATable` refuses a build that would write an edge while any pair maps to more than
one type.

The Department says the same thing in the item description:

> This represents a consistent zoning scheme across all local authorities, and **complements (rather than
> replaces) the existing statutory zoning used for each individual plan**.

**The declared domain is closed, and the source already violates it.** The domain declares 54 codes and the
data uses 55, because `N/A` appears on 4 rows and in no domain. `zoning_vocabulary` therefore carries the
declared domain **plus** the values observed in the data, and the `declared` column separates them. Merging the
two would either hide a source-schema change or invent a declaration that the Department never made. For the
same reason, a declared code that the data never uses is kept with `observed_rows = 0`. `SDZ` is a real plan
level that nobody has used yet.

## Three measured source behaviors a builder has to know

### Hole roles come from ring ORIENTATION, and clockwise is the exterior

This is the inverse of RFC 7946's convention, and it is the one property of this source that silently produces
a well-formed wrong answer. These figures cover the whole national export (85,330 features, 93,483 rings):

| reading                                                    |         km² |
| ---------------------------------------------------------- | ----------: |
| sum of signed ring areas, in the source's own ITM meters   | **5,444.5** |
| the Department's own `Shape__Area` sum                     | **5,444.5** |
| sum of absolute ring areas, in the source's own ITM meters | **5,666.6** |

**In the source's own projection, the signed sum matches the publisher to eight decimal places**
(5,444,492,956.43 m² against 5,444,492,956.40), which settles the convention. The build compares a spherical
reading of the reprojected rings, so its own numbers sit a few tenths of a percent away from both: 5,423.2 km²
with holes against the publisher's 5,444.5 (**0.392% apart**), and 5,644.4 km² without them (**3.7% away**).
The gap between those two readings is the signal, and the 1% build tolerance sits between them with room on
each side. Irish Transverse Mercator's scale factor and the spherical approximation together contribute a few
tenths of a percent, and ignoring holes contributes ten times that.

89,967 rings are clockwise and 3,516 are counter-clockwise, and 1,309 features carry both windings. Of those,
1,210 nest their holes inside one polygon part as RFC 7946 expects. The rest put every ring in its own
`MultiPolygon` part. The largest feature in the country, Meath's `RA - Rural Area`, arrives as 107 single-ring
parts, of which 5 are clockwise and 102 counter-clockwise. **Both encodings reach the ingest, and orientation is
the only signal that means the same thing in both.**

**Two residual cases are measured and handled instead of rejected.** Nine of the 3,516 holes share their
parent's boundary instead of sitting inside it. Each is a sliver under 1.7 m², and each is assigned to the
smallest exterior of its own feature, which on eight of the nine is the feature's only exterior. **Exactly one
feature of 85,330** has no ring that the rule can read as an exterior: `OBJECTID` 74040, Galway County
Council's `Agriculture`, a three-vertex ring enclosing 3.0 × 10⁻⁷ m². At that magnitude a ring's winding is
floating-point noise and not something the publisher stated. It reads clockwise in the source's own Irish
Transverse Mercator meters and counter-clockwise after reprojection. The largest ring by magnitude therefore
becomes the exterior, which is also the correct reading for a feature published wholly inverted. The build
receipt reports both counts explicitly.

The area error is 4.1%, and it is the harmless consequence. The harmful consequence is that a ray cast
treating all 107 rings as exteriors answers "inside `P5` rural zoning" for every location the plan carved out.

**GDAL has no option that preserves this orientation**, so the ingest streams WKT instead of GeoJSON. GDAL's
GeoJSON writer always enforces the RFC 7946 winding. `-lco RFC7946=NO` is not a GeoJSONSeq option, and
`--config OGR_ORGANIZE_POLYGONS SKIP` has no effect. Through GeoJSONSeq the Meath feature therefore arrives as
107 counter-clockwise exteriors totalling 2,371.9 km² against the Department's 2,232.1 km². The same
conversion written as CSV/WKT keeps the source's 5/102 split intact.

### The publisher's own area column is not in the archive

`Shape__Area` is a service field, and the bulk GeoJSON export drops it. The area cross-check therefore reads
it from the live service, which makes the check compare two independent paths instead of comparing the
archive with itself. The measured value is 5,444,492,956.40 m² over 85,330 features.

### The definition host has no DNS record

All 85,330 rows link their generic type's definition to `viewer.myplan.ie`, which has no A or AAAA record,
and three candidate replacements on the live host answer HTTP 404. The 54 code-to-label pairs survive in the
service's own coded-value domain, but the **definitions** behind them are lost. `zoning_vocabulary.definition_url`
is therefore NULL on every row instead of holding a plausible guess.

### And two acquisition behaviors

- The Hub download job answers `{"status":"Completed","resultUrl":…}` in 249 bytes, and the result URL returns
  **302**. The transfer follows redirects. A client that took the first response as the file would write a
  redirect page to disk and report a successful download.
- The bulk export is **EPSG:2157** (IRENET95 / Irish Transverse Mercator), declared in a top-level `crs` member
  that RFC 7946 removed from the format. GDAL honours the legacy member. A strict reader ignores it and places
  Ireland's zoning at latitude 735,435. The ingest asserts the source's declared authority code before reading
  a feature, and asserts that every reprojected vertex lies inside the Department's own declared extent.

## The two tiers

`zoning_area` holds the authority's **unsimplified** rings with their hole roles resolved, plus a precomputed
bounding box. `zoning_cell` is an H3 containment index above it, `WITHOUT ROWID`, keyed `(h3_cell, area_id)`.
A probe walks the index first and reads the geometry only for a cell that a boundary crosses.

**The index records every cell that touches a polygon, never only cells whose center lies in it**, and a
feature that reaches no cell fails the build. The measurements require this. `polygonToCells`, the usual
first choice of polyfill, returns no cells for most of these polygons. Every dropped polygon would appear
downstream as an absence of zoning, which is exactly the question this layer exists to answer.

`zoning_cell` rows are **mixed-resolution**. Each feature's whole tier is compacted toward parent cells, so a
row carries its own `resolution`, and a probe walks its own `cellToParent` chain over every resolution the
table holds. `layer_coverage` stays single-resolution.

## The resolution is a measurement, and not the one the size interface names

The inherited size interface picks a resolution from the measured `partial` share. **For this subject that
statistic carries no signal**, and measurement shows why. Most zoning polygons are smaller than a cell:

| percentile |  p1 |  p5 | p10 |   p25 |   **p50** |    p75 |    p90 |    p95 |     p99 |
| ---------- | --: | --: | --: | ----: | --------: | -----: | -----: | -----: | ------: |
| area (m²)  |   9 | 132 | 317 | 1,258 | **4,497** | 14,991 | 44,432 | 89,755 | 486,787 |

Against H3 average cell areas (h3-js 4.5.0): res 9 = 105,333 m², res 10 = 15,048 m², res 11 = 2,150 m².
**95.7% of zoning polygons are smaller than an average res-9 cell**, 75.1% smaller than a res-10 cell and
34.5% are smaller than a res-11 cell. The `partial` share therefore sits near 100% at every candidate and
cannot choose between them.

Two other numbers can choose. `mailwoman gazetteer build zoning --measure-resolutions 9,10,11` measures both
over the full national set:

| res    | features | polyfill-only zero-cell | stored cell rows | touched cells | candidates/cell mean |   p90 | max | cells >1 candidate | partial share | coarsened |
| ------ | -------: | ----------------------: | ---------------: | ------------: | -------------------: | ----: | --: | -----------------: | ------------: | --------: |
| 9      |   85,330 |          73,068 (85.6%) |           48,882 |        68,184 |                 3.39 |     9 |  90 |     28,056 (41.1%) |         58.0% |         0 |
| **10** |   85,330 |          48,412 (56.7%) |          237,411 |       426,993 |             **1.69** | **3** |  55 |    121,884 (28.5%) |         40.6% |         0 |
| 11     |   85,330 |          19,224 (22.5%) |        1,121,461 |     1,897,777 |                 1.32 |     2 |  23 |    432,969 (22.8%) |         37.0% |         1 |

**Resolution 10 was chosen from those numbers.** Going from 9 to 10 reduces the p90 candidate count from 9 to
3, a threefold reduction in the geometry a fringe probe reads, for 4.9× the stored rows. Going from 10 to 11
reduces p90 from 3 to 2 for another 4.7× the rows. The curve bends at 10. The `partial` share (58.0 / 40.6 /
37.0%) shows no bend at all, which confirms that it is the wrong column to choose on.

**The polyfill column shows the most dangerous failure.** At resolution 9, `polygonToCells` returns no cells
for **73,068 of 85,330 polygons (85.6%)**, because no cell center falls inside them. A builder that indexed
only the polyfill output would silently drop six of every seven zoning polygons, and every dropped polygon
would appear downstream as "no zoning here". Even at resolution 11 it drops 22.5%. The survey measured 86.8% on
one urban authority, and the national figure, measured directly, is 85.6%.

This index's own zero-cell count is **0 at every resolution** by construction. `classifyFeatureCells` uses
overlapping containment and throws on a feature that reaches no cell. The allocator budget forces one feature
(Meath's 2,232 km² rural zone) to be indexed coarser than 11, so the `coarsened` column reads 1 there.

## The build, as it ran

The full national build ran on this lab at the chosen resolution 10, with coverage at res 6:

| what                | measured                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| acquisition         | 247,452,342 bytes in 42.0 s, one anonymous request following the Hub job's redirect                                           |
| features            | **85,330**; the archive, the service's `returnCountOnly` and the build all agree                                              |
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

The build is **batched**, with one child process per range of the authority's own feature ids. h3's WASM heap
cannot be reset from JavaScript and fails after an unbounded number of polyfill calls. This product's 85,330
features fit inside the 100,000-id default, but the bound ships anyway, because it guarantees the limit instead
of relying on the current feature count.

## Verification

`--verify` runs both halves against the Department's own feature service.

**Positive half.** The check answers a deterministic sample of interior points, spread across authorities, from
the sealed artifact and then asks the live service about the same points. The service's rings get the same
hole-role resolution that the ingest applied to the archive's rings, so the check compares one verdict against
another. A point within half a meter of a service-polygon edge is reported as `boundary_tolerance` instead of a
disagreement, together with its distance **to the nearest edge**. A point a centimeter from a long edge can be
meters from every vertex of that edge.

**Negative half. This half matters more here than for any sibling layer.** Donegal points and Northern Irish
points must return `unknown` with no designation. A positive-only check would pass on an artifact that
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

A shipped layer needs one grant that it can quote, and this record does not have one. As a result:

- `layer_manifest.license` is **`NOASSERTION`**, SPDX's own token for a determination nobody has made. Writing
  `CC-BY-4.0` there while an all-rights-reserved clause identifies a licensor would mean this program asserting
  a grant.
- `layer_manifest.tier` is **`build-local`**, and `assertTierMatchesLicense` refuses a `shipped` build while the
  license reads `NOASSERTION`. Changing the tier requires a deliberate edit at a line that states what is
  unresolved.
- `layer_manifest.attribution` carries **both parts**, the Department's credit line and the Tailte Éireann
  clause, because a re-user who saw only the first would not know that the second exists.

**What would change it:** The myplan.ie disclaimer points to a fourth statement as authoritative ("For full
details of conditions of use please see map viewer splash screen"), and that splash text was not retrieved. Two
ArcGIS instant-app configurations linked from the viewer page were read, and neither belongs to the zoning
viewer. The splash text is the single fact that would move this layer from `build-local` to `shipped`.

The npm package is unaffected. `@mailwoman/zoning` publishes with every release from `.release-it.json`'s
workspace list. The `build-local` tier applies to the data alone.

## The mapped-footprint question — what is settled, and what would change it

`zoning_mapped_extent` ships **empty**, which records that no mapped footprint is known. The Department states
"Awaiting data for some Local Authorities - please see map viewer for coverage details" and publishes that
detail only inside a map application. Donegal's absence was found by measuring `LA_CODE`, not read from a
coverage statement. It is unknown whether other authorities are only partially represented.

**Deriving a footprint from the union of the zoning polygons is forbidden**, for the same reason the flood layer
forbids it. The union of zoned areas differs from the area the authority examined, and that difference is
exactly what a negative answer would need to report. The union is not even a stable shape here. One authority's
drafting convention changes the national zoned-area figure by 41%, because Meath County Council zones its entire
rural remainder as one 2,232 km² polygon, against 32.5 km² for the next largest polygon in the country.

The Department would need to publish a statement of the area it mapped, together with its geometry, before this
layer could move from `source_present` to a stronger basis.

## Consumer

`packages/mailwoman/lib/observations/zoning-route.ts` reads a finished coordinate and records what an adopted plan
assigns there, as one additive `authority_designation` marker with `mechanism: layer:zoning`. **The route is off
by default and turns on when `$MAILWOMAN_DATA_ROOT/db/zoning/zoning-ireland.db` exists.** The file's presence is the only switch.
Without the layer file the route does not run, and the geocode result is byte-identical to a build without the
field.

## See also

- The survey that produced this layer: `docs/superpowers/specs/2026-08-27-zoning-layer-survey.md`.
- The layer interface: `docs/engineering/reference/layer-interface.mdx`.
- The runtime-flag register: `docs/engineering/reference/runtime-flags.mdx`.
