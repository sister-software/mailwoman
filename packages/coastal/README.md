# `@mailwoman/coastal`

The Environment Agency's **National Coastal Erosion Risk Mapping (NCERM) — National (2024)** for
England as a sealed spatial layer: acquisition, the `coastal-england.db` build, and the reader that
answers what the authority's mapping assigns at a coordinate **under a named scenario**.

Design record: [`docs/superpowers/specs/2026-08-27-erosion-layer-survey.md`](../../docs/superpowers/specs/2026-08-27-erosion-layer-survey.md).
Contract: [`docs/engineering/reference/layer-contract.mdx`](../../docs/engineering/reference/layer-contract.mdx).

## What it reports, and what it refuses to

Two readings — and the one that is **missing** is the point of this layer existing beside
`@mailwoman/flood`:

| reading      | what it means                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `designated` | the authority's mapping places the location inside an erosion zone under the scenario asked for                 |
| `unknown`    | no polygon of that scenario contains the point. **Not an absence claim, and this layer has no absence reading** |

**There is no `designated_absence` here, and that is the inversion of the flood layer.** For flood
zones the Environment Agency states England-wide coverage and the Planning Practice Guidance defines
Zone 1 as "all land outside Zones 2, 3a and 3b" — so an empty answer inside England IS a
designation. NCERM publishes no coverage statement at all. A location in England with no erosion
polygon is either **inland** — most of the country, about which the product says nothing — or **on
the coast and outside the mapped risk area**, which is the designation a caller wants; and
the published layers cannot tell those apart. A reader that generalized the flood rule would report
the whole country as free of coastal-erosion risk, on a well-formed artifact that passed every
structural check.

So `layer_coverage` carries `basis = source_present` on every row, and the posture is a **checked
condition at both ends** rather than a convention: the build refuses to write a row that would
support an exclusion, and the reader refuses to open an artifact carrying one. Moving this layer to
a stronger basis takes a deliberate edit at a guard that names the reason.

**A probe must name its scenario.** NCERM publishes twelve erosion-zone layers because the answer
depends on which management scenario, which time horizon and which sea-level-rise allowance the
reader means. Every stored row, every index row and every reading names its scenario; an
unrecognized scenario key throws rather than answering as an absence, because "no such scenario" and
"no zone here" are opposite facts that would otherwise look identical.

**Nothing here is a statement about a property.** The layer reports what the authority's map assigns
at a location under a named scenario, which is a fact about the map. The Environment Agency states
that its data "cannot provide details for individual properties", and every reading carries the
product's own exclusions — an erosion answer is silent about flooding and about foreshore features.

## The twelve scenarios

`NCERM_{NFI|SMP}_{2055|2105}_{0|70|95}CC` — a cross product of three axes, keyed here without the
`NCERM_` prefix (`NFI_2055_0CC`, `SMP_2105_95CC`, …):

| axis                | values                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| management scenario | `NFI` No Future Intervention; `SMP` With Shoreline Management Plans delivered                   |
| horizon             | `2055` Medium Term; `2105` Long Term                                                            |
| climate allowance   | `0CC` present day (2020); `70CC` / `95CC` UKCP18 RCP8.5 70th and 95th percentile sea-level-rise |

The **distance column's name varies per layer** — `nfi2055_0` on NFI/2055/0CC, `smp2105_95` on
SMP/2105/95CC — and the ingest aliases whichever one the scenario declares. The **NFI layers omit
the four Shoreline Management Plan policy fields** entirely, because under a no-intervention
scenario there is no policy to record; a builder that defaulted them would invent one.

The route's default scenario is **`NFI_2055_0CC`**, and it is never hidden: every reading names the
scenario it answered under. Among the twelve it is the least projected — `NFI` assumes no future
works are delivered rather than assuming a plan's delivery, `0CC` is the present-day allowance
rather than a sea-level-rise projection, and `2055` is the nearer horizon.

## The shape of the source, measured

Read over the whole published geodatabase (2024 edition), because three of the design decisions
below rest on it rather than on an impression:

| layer family                                | layers |   features |
| ------------------------------------------- | -----: | ---------: |
| `NCERM_NFI_{2055,2105}_{0,70,95}CC`         |      6 |     44,230 |
| `NCERM_SMP_{2055,2105}_{0,70,95}CC`         |      6 |     44,981 |
| `NCERM_Ground_Instability_{Recession,Zone}` |      2 |        160 |
| **total**                                   | **14** | **89,371** |

Service and file agree exactly on 89,371, and the four bulk formats total 561.9 MB; the geodatabase
archive is 70,296,882 bytes.

**`frontageid` is not a key, and this is the finding that shaped the schema.** The survey proposed
scoping `area_id` by scenario and keying it on the frontage. Measured, the frontage id is not unique
even **within** one layer: `NCERM_NFI_2055_0CC` holds 7,379 features over 7,369 distinct frontage
ids — frontage 39260 alone appears ten times — and across the twelve layers **835 rows would have
collided**. So `area_id` is `<scenario key>:<OBJECTID>`, the authority's own feature id, and
`frontage_id` rides as an attribute.

**Overlap is real rather than theoretical.** 3,727 of the 7,492 features on `NCERM_SMP_2105_95CC`
carry a non-zero `maxoverlap`, so a cell can name several polygons of one scenario and a reading
reports every one that contains the point. There is no tie-break, because inventing one would be
this package's rule rather than the authority's.

**The declared domains, censused across all twelve layers** rather than one — a domain read from a
single layer throws on the day another layer carries its ninth value:

| field                       | distinct | note                                                                                                                                                                                    |
| --------------------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mt_smp` / `lt_smp`         |    8 / 8 | **nine spellings for eight policies** — `mt_smp` writes `No Active Intervention / Managed Realignment` where `lt_smp` writes `No Active Intervention/Managed Realignment`, same 72 rows |
| `mt_smp_int` / `lt_smp_int` |    4 / 4 | `Erosion restricted`, `Erosion unrestricted`, `Stop Maintaining`, blank                                                                                                                 |
| `def_type`                  |       14 | twelve defences behind fourteen spellings: `Sheet piles` 1,344 beside `Sheet Piles` 270; `Vertical Wall - Concrete` 16,074 beside `Vertical Wall - concrete` 12                         |
| `published`                 |        2 | `2024` on 89,124 rows, `0` on 87                                                                                                                                                        |

Membership for `def_type` is tested **case-folded** and the value is stored **verbatim**: the fold
exists for the source's own inconsistent capitalization, not to absorb a new defence type.

**Blank is a single space, not an empty string** — `" "` on the same 87 rows that carry
`published = 0`, all of them on SMP layers (13 to 16 per layer; the NFI layers have none). A reader
testing `=== ""` finds nothing and reports the anomalous rows as ordinary ones. The Environment
Agency documents no meaning for them, so they are carried as published rather than dropped or
coerced.

Erosion distances carry no nulls: 0–386 m on NFI/2055/0CC, 0–1,053 m on SMP/2105/95CC.

## Three measured client behaviors

Each is encoded in the code rather than written down somewhere else:

1. **The OGC service slug is `ncern`, a misspelling of the product.**
   `…/spatialdata/ncerm-national-2024/wfs?…GetCapabilities` answers HTTP 404;
   `…/spatialdata/ncern-national-2024/wfs?…` answers HTTP 200 with 110,478 bytes. Any client must
   use the misspelling — a build that "corrected" it would lose the service half of the two-path
   verification while reporting a clean run.
2. **`HEAD` answers 405 and `Range` is ignored.** A ranged GET returns HTTP 200 with the whole
   70,296,882-byte body, so freshness can never be probed by content length. The cached archive is
   keyed on the product's ISO revision date instead, which is the authority's own statement about
   what changed.
3. **The attribution comes from the structured license field.** The abstract carries the statement
   twice and the **first copy — inherited from the superseded 2018–2021 record — has no year**; the
   ISO record has no `gmd:credit` element at all. `parseAttributionStatement` takes the copy carrying
   a year and refuses text where none does. OGL v3.0 makes the statement a license condition, so a
   parse taking the first match ships a license condition stated incorrectly.

## The two tiers, and where this differs from the flood layer

`coastal_zone_area` holds the authority's unsimplified rings with a precomputed bounding box — the
truth table. `coastal_zone_cell` is the H3 containment index above it, classifying each cell `whole`
or `partial` **per polygon** rather than per class: an erosion answer IS the polygon, because the
distance, the policy and the defence are per feature. A `whole` cell answers in primary-key probes
alone; only a `partial` cell falls through to the ray cast, against only the polygons the cell names
for that scenario.

**There is no build-time touch table, and its absence follows from the key.** The flood build
accumulates per zone CODE across features, so a cell's containment is not decided until every
feature carrying that code has been seen — hence a temporary table resolved at the end. An erosion
cell row names one polygon, so it is final the moment that polygon is classified. Rows go straight
in, memory stays flat in row count, and there is nothing to resolve afterwards.

`coastal_ground_instability` holds NCERM's two ground-instability layers — a **different hazard**,
160 rows, sharing feature ids and attributes between the two layers and differing in geometry. It
carries **no cell index**, and that absence is the structure: a bounding-box scan over 160 rows costs
less than an index would, and not indexing them is what makes it impossible for a landslide polygon
to reach an erosion probe. `groundInstabilityAt()` is its own method for the same reason.

`coastal_mapped_extent` is **created empty**, and its emptiness is the claim — see below.

## The resolution is a measurement, taken per scenario

`mailwoman gazetteer build coastal --measure-resolutions 9,10,11` streams the real source once per
candidate and reports the table below. **Per scenario, never pooled**: twelve layers cover the same
frontages with different extents, so a pooled `partial` share averages a present-day designation
together with a 2105 projection and describes neither. The number a scenario-scoped probe reads is
one scenario's share.

Measured over all 89,211 erosion features in all twelve scenarios (2026-08-28, 6m49s for the three
candidates in one pass):

| res | stored cell rows | touched cells |   partial | pooled partial share | per-scenario partial share |
| --: | ---------------: | ------------: | --------: | -------------------: | -------------------------- |
|   9 |          170,983 |       170,983 |   170,103 |                99.5% | 99.3 % – 99.5 %            |
|  10 |          588,095 |       593,213 |   560,415 |                94.5% | 92.2 % – 95.8 %            |
|  11 |        2,276,541 |     2,471,517 | 1,869,758 |                75.7% | 68.7 % – 80.8 %            |

Per scenario at the chosen resolution 10 — the number a scenario-scoped probe reads:

| scenario        | features | touched cells | whole | partial | partial share | whole after compaction |
| --------------- | -------: | ------------: | ----: | ------: | ------------: | ---------------------: |
| `NFI_2055_0CC`  |    7,379 |        47,245 | 1,998 |  45,247 |         95.8% |                  1,632 |
| `NFI_2055_70CC` |    7,370 |        48,446 | 2,171 |  46,275 |         95.5% |                  1,787 |
| `NFI_2055_95CC` |    7,370 |        48,767 | 2,234 |  46,533 |         95.4% |                  1,850 |
| `NFI_2105_0CC`  |    7,370 |        49,876 | 2,670 |  47,206 |         94.6% |                  2,256 |
| `NFI_2105_70CC` |    7,371 |        54,438 | 3,960 |  50,478 |         92.7% |                  3,486 |
| `NFI_2105_95CC` |    7,370 |        55,917 | 4,372 |  51,545 |         92.2% |                  3,826 |
| `SMP_2055_0CC`  |    7,501 |        45,703 | 1,901 |  43,802 |         95.8% |                  1,535 |
| `SMP_2055_70CC` |    7,501 |        46,444 | 2,033 |  44,411 |         95.6% |                  1,655 |
| `SMP_2055_95CC` |    7,500 |        46,640 | 2,071 |  44,569 |         95.6% |                  1,693 |
| `SMP_2105_0CC`  |    7,493 |        47,344 | 2,334 |  45,010 |         95.1% |                  1,932 |
| `SMP_2105_70CC` |    7,494 |        50,664 | 3,364 |  47,300 |         93.4% |                  2,884 |
| `SMP_2105_95CC` |    7,492 |        51,729 | 3,690 |  48,039 |         92.9% |                  3,144 |

No feature was coarsened at any of the three candidates: NCERM's largest polygon's bounding box fits
h3's allocator budget at resolution 11, which is why the `coarsened` column is zero throughout and is
omitted above. **The measurement's row count is a LOWER BOUND on the stored table**, and says so
rather than being presented as the artifact's size: this instrument accumulates a set of cells per
scenario, while the table keys `(cell, polygon)` — two frontages of one scenario reaching one cell are
two rows here and one there. On this product the gap is small, because coastal frontages abut rather
than overlap; the build's own receipt reports the real number.

**Resolution 10 is the chosen index resolution, and the numbers are why rather than a cell-area
argument.** The survey predicted a high `partial` share and little `compactCells` yield, and both
hold across every scenario: NCERM's zones are narrow strips hugging the coast, so the landward
boundary crosses almost every cell it reaches and there are few interiors to collapse — compaction
takes 4,372 whole cells to 3,826 at its most useful, and 95 to 95 at resolution 9.

Resolution 9 is refused because its index answers 0.5 % to 0.7 % of in-layer probes: it would narrow
candidates and nothing more. Resolution 11 costs **3.9× the rows** (2.28 M against 0.59 M) to raise
the index-answered share from about 5.5 % to about 24 %, and the ray cast stays the common path
either way. Since the candidate set per cell is tiny — a coastal frontage is not a river network —
the probe saving does not buy four times the cell tier. Resolution 10 keeps that tier under 600 k
rows and still narrows every probe to a handful of polygons.

## The build, as it ran

The national build, at the chosen resolution 10 with coverage at 6 (2026-08-28, 2m12s over the whole
product):

| what                    | value                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| erosion polygons        | 89,211 across 12 scenarios, each layer's count matching the live WFS per layer               |
| ground-instability rows | 160, in their own table, with no cell index                                                  |
| cell rows               | 27,680 whole (compacted per feature) + 701,839 partial = 729,519, at resolutions 9 and 10    |
| stored `partial` share  | 96.2 %                                                                                       |
| features coarsened      | 0                                                                                            |
| coverage                | 577 cells at resolution 6, every one `source_present`                                        |
| area agreement          | source 2,725.0 km² against 2,715.1 km² from the encoded rings — 0.362 % apart, tolerance 1 % |
| area read without holes | 2,717.2 km², so the holes account for 2.1 km²                                                |
| defence types seen      | 14 distinct, matching the census exactly                                                     |
| artifact                | 310.7 MB, sealed 0444                                                                        |
| verify                  | **48/48 agree with the live OGC service**, 0 within boundary tolerance, 0 disagree           |
| verify, negative half   | **8/8 read `unknown` with no designation**, none read a designation                          |

The stored 729,519 rows against the measurement's 588,095 is the lower-bound gap named above, at
24 %: two frontages of one scenario reaching one cell are one cell to the instrument and two rows to
the table.

Four named coordinates, read back out of the sealed artifact, showing what the scenario scoping is
for:

| coordinate                                   | `NFI_2055_0CC`           | `SMP_2105_95CC`          |
| -------------------------------------------- | ------------------------ | ------------------------ |
| Happisburgh, Norfolk (52.8236, 1.5352)       | unknown                  | designated, 160 m        |
| Withernsea, East Yorkshire (53.7305, 0.0341) | designated, 175 m        | unknown                  |
| Birling Gap, East Sussex (50.7433, 0.2003)   | designated, 12 m         | designated, 62 m         |
| Birmingham city center (52.4796, −1.9026)    | unknown, no coverage row | unknown, no coverage row |

The first two rows move in OPPOSITE directions, and both are the authority's own reading rather than
a defect. Happisburgh is outside the medium-term present-day band and inside the long-term band under
the 95th-percentile allowance; Withernsea is inside the no-intervention band and outside the
with-plans-delivered one, because the shoreline management policy for that frontage restricts erosion.
A layer that pooled the twelve would have to answer both with one number.

The third row is the ordinary case — the same frontage, a larger distance at the longer horizon. The
fourth is the one this layer's coverage posture exists for: an inland English coordinate gets no
coverage row and no designation, and that is reported as "this product says nothing here" rather than
as a reassurance.

## The footprint question — what is settled, and what would change it

**Settled as built:** no mapped-footprint source exists for this product, so `layer_coverage` carries
`basis = source_present`, `coastal_mapped_extent` is empty, and the layer supports **presence only**.
A coverage row means "this product has data in this cell"; its absence means nothing at all. Neither
reading licenses a claim that a location is not at risk.

**What would move it to `designated`:** a published statement of the area the Environment Agency
MAPPED, plus its geometry. Two candidates are named in the survey and **neither is verified**:

- The **Shoreline Management Plan Mapping** record, a sibling dataset on the same platform. NCERM's
  own lineage states it is derived from the Shoreline Management Plans, and every erosion feature
  carries `smp_no`, `smp_name` and `smp_pu` — measured, `smp_no` runs 0–22 over 21 distinct values.
  Its coverage statement, license, extent and schema were not read.
- The **frontage geometry behind `frontageid`**. Whether the Environment Agency publishes the
  frontages themselves, rather than only their id, was not established.

**What is forbidden:** deriving a footprint from the union of the erosion polygons. The union of "at
risk" areas is not the mapped area, and the difference is the whole content of a negative answer —
the same rule the flood layer states for the same reason.

Two further limits the coverage row cannot express, both from the authority's own text: the product
"considers the predominant risk at the coast" and generally excludes foreshore features, so an NCERM
answer is silent about flooding; and the 87 anomalous rows carry blank policy and defence fields with
`published = 0`, which the Environment Agency documents no meaning for.

## Building it

```bash
# Fixtures — no network, no GDAL.
yarn vitest run --root packages/coastal

# Smoke: one scenario, a prefix of the real source.
mailwoman gazetteer build coastal --scenarios NFI_2055_0CC --limit 500

# The resolution measurement (does not build).
mailwoman gazetteer build coastal --measure-resolutions 9,10,11

# Full, with the two-path agreement check.
mailwoman gazetteer build coastal --verify
```

The ingest reprojects EPSG:27700 to WGS84 and asserts every reprojected vertex lands inside the
authority's own declared bounding box. **It also asks PROJ which transformation it would choose and
refuses a ballpark one**: without the OSTN15 grid PROJ substitutes a ballpark datum shift and
produces coordinates that are meters wrong and look exactly like correct ones. On the sibling flood
product that surfaced only as eight disagreements out of 59 against the authority's own service.
Install it with `projsync --area-of-use "United Kingdom"`.

The full build runs **one child process per scenario layer**, plus one for the two ground-instability
layers. h3's WASM heap cannot be reset from JavaScript and does not survive an unbounded number of
polyfill calls — the flood build died twice on that, after roughly 510,000 and 798,000 features.
NCERM's largest layer holds 7,501 features, so one chunk per layer fits inside the 100,000-id default
with two orders of magnitude to spare; the bound ships anyway, because a build that stays inside a
ceiling by luck is not the same fact as one that cannot cross it.

## Verification

`--verify` runs both halves against the Environment Agency's own OGC API Features service — the same
authority, a different distribution channel, and geometry this package has never touched. The point
test is run again on the service's own rings, so what is compared is a verdict against a verdict.

**The negative half matters more here than it did for the flood layer.** Inland English points and
Welsh and Scottish coastal points must come back `unknown` with no designation. Wales publishes NCERM
on the previous generation's vocabulary (three periods from a 2005 base, percentile bands), Scotland's
Dynamic Coast carries an explicit prohibition on property-level assessment, and Northern Ireland
publishes 122 line segments carrying one attribute — none of them interchangeable with England's. A
positive-only check would pass on an artifact that reported the entire country as designated.

Distances are measured to the **edge**, not to the nearest vertex: a point a centimeter from a long
edge can be meters from every vertex of it, and measuring vertices makes the boundary tolerance far
stricter than it reads.

## Consumer

The reader rides the geocode path only, after the resolver has produced a coordinate.
`mailwoman/observations`' `createCoastalErosionRoute` turns one reading into an additive
`authority_designation` marker with `mechanism: layer:coastal_erosion` — the third rule under the
`layer` family. **Default off, and the switch is the presence of
`$MAILWOMAN_DATA_ROOT/coastal/coastal-england.db`** rather than a boolean; no layer file, no route,
and the geocode result is byte-identical to a build without the field.

The artifact is named for its **extent** rather than for its subject, because the alternatives are not
interchangeable with it — a file called `coastal.db` would invite a Welsh or Scottish product to
overwrite an English one.

## License and posture

OGL v3.0, with the published attribution string
`© Environment Agency copyright and/or database right 2025. All rights reserved.` — which OGL makes a
**condition**, not decoration. Both services report `<Fees>NONE</Fees>`; no registration and no key.
`tier: shipped`.

The workspace publishes with every release from `.release-it.json`'s workspace list.
