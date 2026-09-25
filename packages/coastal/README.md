# `@mailwoman/coastal`

This package provides the Environment Agency's **National Coastal Erosion Risk Mapping (NCERM) —
National (2024)** for England as a sealed spatial layer. It covers acquisition, the
`coastal-england.db` build, and the reader that reports what the authority's mapping assigns at a
coordinate **under a named scenario**.

Design record: [`docs/superpowers/specs/2026-08-27-erosion-layer-survey.md`](../../docs/superpowers/specs/2026-08-27-erosion-layer-survey.md).
Interface: [`docs/engineering/reference/layer-interface.mdx`](../../docs/engineering/reference/layer-interface.mdx).

## What it reports, and what it refuses to

The layer has two readings. The reading it **lacks** is the main difference from
`@mailwoman/flood`:

| reading      | what it means                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `designated` | the authority's mapping places the location inside an erosion zone under the scenario asked for                            |
| `unknown`    | no polygon of that scenario contains the point. This reading does not claim absence, and this layer has no absence reading |

**This layer has no `designated_absence` reading, which is the opposite of the flood layer.** For
flood zones the Environment Agency states England-wide coverage, and the Planning Practice Guidance
defines Zone 1 as "all land outside Zones 2, 3a and 3b". An empty flood answer inside England is
therefore a designation. NCERM publishes no coverage statement. A location in England with no
erosion polygon is either **inland**, which covers most of the country and about which the product
says nothing, or **on the coast and outside the mapped risk area**, which is the designation a caller
wants. The published layers cannot tell those two cases apart. A reader that applied the flood rule
would report the whole country as free of coastal-erosion risk, from a well-formed artifact that
passed every structural check.

`layer_coverage` therefore carries `basis = source_present` on every row. Both ends check this
condition in code. The build refuses to write a row that would support an exclusion, and the reader
refuses to open an artifact that carries one. Moving this layer to a stronger basis requires a
deliberate edit at a guard that states the reason.

**A probe must specify its scenario.** NCERM publishes twelve erosion-zone layers because the answer
depends on the management scenario, the time horizon, and the sea-level-rise allowance. Every stored
row, every index row, and every reading records its scenario. An unrecognized scenario key throws
instead of answering as an absence, because "no such scenario" and "no zone here" are opposite facts
that would otherwise look identical.

**No reading is a statement about a property.** The layer reports what the authority's map assigns
at a location under a named scenario, which is a fact about the map. The Environment Agency states
that its data "cannot provide details for individual properties", and every reading carries the
product's own exclusions. An erosion answer says nothing about flooding or about foreshore features.

## The twelve scenarios

The layer names follow `NCERM_{NFI|SMP}_{2055|2105}_{0|70|95}CC`, the cross product of three axes.
This package keys them without the `NCERM_` prefix (`NFI_2055_0CC`, `SMP_2105_95CC`, …):

| axis                | values                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| management scenario | `NFI` No Future Intervention; `SMP` With Shoreline Management Plans delivered                   |
| horizon             | `2055` Medium Term; `2105` Long Term                                                            |
| climate allowance   | `0CC` present day (2020); `70CC` / `95CC` UKCP18 RCP8.5 70th and 95th percentile sea-level-rise |

The **distance column's name varies per layer**, for example `nfi2055_0` on NFI/2055/0CC and
`smp2105_95` on SMP/2105/95CC. The ingest aliases whichever column the scenario declares. The **NFI
layers omit the four Shoreline Management Plan policy fields** entirely, because a no-intervention
scenario has no policy to record. A builder that filled in defaults would invent one.

The route's default scenario is **`NFI_2055_0CC`**, and every reading reports the scenario it
answered under. It is the least projected of the twelve. `NFI` assumes that no future works are
delivered instead of assuming a plan's delivery, `0CC` is the present-day allowance instead of a
sea-level-rise projection, and `2055` is the nearer horizon.

## The shape of the source, measured

These figures come from reading the whole published geodatabase (2024 edition). Three of the design
decisions below depend on them:

| layer family                                | layers |   features |
| ------------------------------------------- | -----: | ---------: |
| `NCERM_NFI_{2055,2105}_{0,70,95}CC`         |      6 |     44,230 |
| `NCERM_SMP_{2055,2105}_{0,70,95}CC`         |      6 |     44,981 |
| `NCERM_Ground_Instability_{Recession,Zone}` |      2 |        160 |
| **total**                                   | **14** | **89,371** |

The service and the file agree exactly on 89,371 features. The four bulk formats total 561.9 MB, and
the geodatabase archive is 70,296,882 bytes.

**`frontageid` is not a unique key, and this finding shaped the schema.** The survey proposed
scoping `area_id` by scenario and keying it on the frontage. The measured frontage id is not unique
even **within** one layer. `NCERM_NFI_2055_0CC` holds 7,379 features over 7,369 distinct frontage
ids, and frontage 39260 alone appears ten times. Across the twelve layers, **835 rows would have
collided**. `area_id` is therefore `<scenario key>:<OBJECTID>`, which uses the authority's own
feature id, and `frontage_id` is stored as an attribute.

**Polygons within one scenario overlap in practice.** 3,727 of the 7,492 features on
`NCERM_SMP_2105_95CC` carry a non-zero `maxoverlap`. A cell can therefore reference several polygons
of one scenario, and a reading reports every polygon that contains the point. The reader applies no
tie-break, because any tie-break would be this package's rule and not the authority's.

**The declared domains were censused across all twelve layers** instead of one. A domain read from a
single layer would throw on the day another layer carries its ninth value:

| field                       | distinct | note                                                                                                                                                                                    |
| --------------------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mt_smp` / `lt_smp`         |    8 / 8 | **nine spellings for eight policies** — `mt_smp` writes `No Active Intervention / Managed Realignment` where `lt_smp` writes `No Active Intervention/Managed Realignment`, same 72 rows |
| `mt_smp_int` / `lt_smp_int` |    4 / 4 | `Erosion restricted`, `Erosion unrestricted`, `Stop Maintaining`, blank                                                                                                                 |
| `def_type`                  |       14 | twelve defences behind fourteen spellings: `Sheet piles` 1,344 beside `Sheet Piles` 270; `Vertical Wall - Concrete` 16,074 beside `Vertical Wall - concrete` 12                         |
| `published`                 |        2 | `2024` on 89,124 rows, `0` on 87                                                                                                                                                        |

Membership for `def_type` is tested **case-folded**, and the value is stored **verbatim**. The case
fold handles the source's own inconsistent capitalization and is not meant to accept a new defence
type.

**A blank field holds a single space.** The value `" "` appears on the same 87 rows
that carry `published = 0`, all on SMP layers (13 to 16 per layer; the NFI layers have none). A reader
that tests `=== ""` finds nothing and reports the anomalous rows as ordinary ones. The Environment
Agency documents no meaning for these rows, so the build stores them as published instead of dropping
or coercing them.

Erosion distances carry no nulls. They range over 0–386 m on NFI/2055/0CC and 0–1,053 m on
SMP/2105/95CC.

## Three measured client behaviors

The code encodes each of these behaviors directly:

1. **The OGC service slug is `ncern`, a misspelling of the product.**
   `…/spatialdata/ncerm-national-2024/wfs?…GetCapabilities` answers HTTP 404, and
   `…/spatialdata/ncern-national-2024/wfs?…` answers HTTP 200 with 110,478 bytes. Any client must
   use the misspelling. A build that "corrected" it would lose the service half of the two-path
   verification while still reporting a clean run.
2. **`HEAD` answers 405, and `Range` is ignored.** A ranged GET returns HTTP 200 with the whole
   70,296,882-byte body, so content length cannot be used to check freshness. The cached archive is
   keyed on the product's ISO revision date instead, which is the authority's own statement about
   what changed.
3. **The attribution comes from the structured license field.** The abstract carries the statement
   twice. The **first copy, inherited from the superseded 2018–2021 record, has no year**, and the
   ISO record has no `gmd:credit` element. `parseAttributionStatement` takes the copy that carries a
   year and rejects text where no copy does. OGL v3.0 makes the statement a license condition, so a
   parser that took the first match would ship a license condition stated incorrectly.

## The two tiers, and where this differs from the flood layer

`coastal_zone_area` holds the authority's unsimplified rings with a precomputed bounding box, and every
containment answer is decided against those rings. `coastal_zone_cell` is the H3 containment index above it. It classifies each
cell as `whole` or `partial` **per polygon** instead of per class, because the distance, the policy,
and the defence belong to each feature, so an erosion answer is a polygon. A `whole` cell answers
with primary-key probes alone. Only a `partial` cell falls through to the ray cast, and the ray cast
runs only against the polygons that the cell lists for that scenario.

**The build has no build-time touch table, because of how the cell key works.** The flood build
accumulates per zone code across features, so a cell's containment is not decided until the build has
seen every feature with that code. The flood build therefore resolves a temporary table at the end.
An erosion cell row references one polygon, so the row is final as soon as that polygon is
classified. Rows are written directly, memory use does not grow with row count, and nothing needs
resolving afterwards.

`coastal_ground_instability` holds NCERM's two ground-instability layers, which describe a
**different hazard**. The table has 160 rows. The two layers share feature ids and attributes and
differ in geometry. The table has **no cell index**. A bounding-box scan over 160 rows costs less than
an index would, and leaving the rows unindexed makes it impossible for a landslide polygon to reach an
erosion probe. `groundInstabilityAt()` is a separate method for the same reason.

`coastal_mapped_extent` is **created empty**. The empty table records that no mapped footprint
exists, as described below.

## The resolution is a measurement, taken per scenario

`mailwoman gazetteer build coastal --measure-resolutions 9,10,11` streams the real source once per
candidate and reports the table below. **The measurement is per scenario and never pooled.** Twelve
layers cover the same frontages with different extents, so a pooled `partial` share would average a
present-day designation with a 2105 projection and describe neither. A scenario-scoped probe sees one
scenario's share.

Measured over all 89,211 erosion features in all twelve scenarios (2026-08-28, 6m49s for the three
candidates in one pass):

| res | stored cell rows | touched cells |   partial | pooled partial share | per-scenario partial share |
| --: | ---------------: | ------------: | --------: | -------------------: | -------------------------- |
|   9 |          170,983 |       170,983 |   170,103 |                99.5% | 99.3 % – 99.5 %            |
|  10 |          588,095 |       593,213 |   560,415 |                94.5% | 92.2 % – 95.8 %            |
|  11 |        2,276,541 |     2,471,517 | 1,869,758 |                75.7% | 68.7 % – 80.8 %            |

The per-scenario figures at the chosen resolution 10 are the numbers a scenario-scoped probe sees:

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

No feature was coarsened at any of the three candidates. The bounding box of NCERM's largest polygon
fits h3's allocator budget at resolution 11, so the `coarsened` column is zero throughout and is
omitted above. **The measurement's row count is a lower bound on the stored table** and is not the
artifact's size. The measurement accumulates a set of cells per scenario, while the table keys
`(cell, polygon)`. Two frontages of one scenario that reach one cell count as one cell in the
measurement and two rows in the table. On this product the gap is small, because coastal frontages
abut and rarely overlap. The build's own receipt reports the real number.

**Resolution 10 is the chosen index resolution, and the measured numbers justify it.** The survey
predicted a high `partial` share and little `compactCells` yield, and both predictions hold across
every scenario. NCERM's zones are narrow strips along the coast, so the landward boundary crosses
almost every cell it reaches and few interior cells remain to collapse. At its most useful,
compaction reduces 4,372 whole cells to 3,826, and at resolution 9 it reduces 95 to 95.

Resolution 9 is rejected because its index answers only 0.5 % to 0.7 % of in-layer probes, so it
would only narrow candidates. Resolution 11 costs **3.9× the rows** (2.28 M against 0.59 M) to raise
the index-answered share from about 5.5 % to about 24 %, and the ray cast remains the common path at
either resolution. The candidate set per cell is tiny, because a coastal frontage is much simpler
than a river network. The probe saving does not justify four times the cell tier. Resolution 10
keeps that tier under 600 k rows and still narrows every probe to a handful of polygons.

## The build, as it ran

The national build ran at the chosen resolution 10 with coverage at resolution 6 (2026-08-28, 2m12s
over the whole product):

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

The difference between the stored 729,519 rows and the measurement's 588,095 is the lower-bound gap
described above, at 24 %. Two frontages of one scenario that reach one cell count as one cell in the
measurement and two rows in the table.

Four named coordinates, read back from the sealed artifact, show why readings are scoped by scenario:

| coordinate                                   | `NFI_2055_0CC`            | `SMP_2105_95CC`           |
| -------------------------------------------- | ------------------------- | ------------------------- |
| Happisburgh, Norfolk (52.8236, 1.5352)       | unknown                   | designated, 160 m         |
| Withernsea, East Yorkshire (53.7305, 0.0341) | designated, 175 m         | unknown                   |
| Birling Gap, East Sussex (50.7433, 0.2003)   | designated, 12 m          | designated, 62 m          |
| Birmingham city center (52.4796, −1.9026)    | unknown (no coverage row) | unknown (no coverage row) |

The first two rows move in opposite directions, and both are the authority's own readings. Neither is
a defect. Happisburgh is outside the medium-term present-day band and inside the long-term band under
the 95th-percentile allowance. Withernsea is inside the no-intervention band and outside the
with-plans-delivered band, because the shoreline management policy for that frontage restricts
erosion. A layer that pooled the twelve scenarios would have to answer both with one number.

The third row is the ordinary case: the same frontage has a larger distance at the longer horizon.
The fourth row shows the case that the coverage rules are designed for. An inland English coordinate
gets no coverage row and no designation, and the reader reports that the product says nothing there.
The reader does not present it as reassurance.

## The footprint question — what is settled, and what would change it

**Settled as built:** This product has no mapped-footprint source, so `layer_coverage` carries
`basis = source_present`, `coastal_mapped_extent` is empty, and the layer supports **presence only**.
A coverage row means "this product has data in this cell", and a missing coverage row means nothing.
Neither reading supports a claim that a location is free of risk.

**What would move it to `designated`:** The Environment Agency would need to publish a statement of
the area it mapped, together with its geometry. The survey lists two candidates, and **neither is
verified**:

- The **Shoreline Management Plan Mapping** record, a sibling dataset on the same platform. NCERM's
  own lineage states that it is derived from the Shoreline Management Plans, and every erosion feature
  carries `smp_no`, `smp_name` and `smp_pu`. The measured `smp_no` runs 0–22 over 21 distinct values.
  Its coverage statement, license, extent and schema were not read.
- The **frontage geometry behind `frontageid`**. It is unknown whether the Environment Agency
  publishes the frontages themselves or only their ids.

**What is forbidden:** The build must not derive a footprint from the union of the erosion polygons.
The union of "at risk" areas differs from the mapped area, and that difference is exactly what a
negative answer would need to report. The flood layer states the same rule for the same reason.

The coverage row cannot express two further limits, both taken from the authority's own text. The
product "considers the predominant risk at the coast" and generally excludes foreshore features, so an
NCERM answer says nothing about flooding. The 87 anomalous rows carry blank policy and defence fields
with `published = 0`, and the Environment Agency documents no policy or defence fields for those rows.

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

The ingest reprojects EPSG:27700 to WGS84 and asserts that every reprojected vertex lands inside the
authority's own declared bounding box. **It also asks PROJ which transformation it would choose and
rejects a ballpark transformation.** Without the OSTN15 grid, PROJ substitutes a ballpark datum shift
and produces coordinates that are meters wrong but look exactly like correct ones. On the sibling
flood product, that error appeared only as eight disagreements out of 59 against the authority's own
service. Install the grid with `projsync --area-of-use "United Kingdom"`.

The full build runs **one child process per scenario layer**, plus one for the two ground-instability
layers. h3's WASM heap cannot be reset from JavaScript and fails after an unbounded number of polyfill
calls. The flood build failed twice for this reason, after roughly 510,000 and 798,000 features.
NCERM's largest layer holds 7,501 features, so one chunk per layer fits inside the 100,000-id default
by two orders of magnitude. The bound ships anyway, because it guarantees the limit instead of relying
on the current layer sizes.

## Verification

`--verify` runs both halves against the Environment Agency's own OGC API Features service. The service
comes from the same authority through a different distribution channel, and this package has never
processed its geometry. The point test runs again on the service's own rings, so the check compares
one verdict against another.

**The negative half matters more here than it did for the flood layer.** Inland English points and
Welsh and Scottish coastal points must return `unknown` with no designation. Wales publishes NCERM
with the previous generation's vocabulary (three periods from a 2005 base, percentile bands).
Scotland's Dynamic Coast explicitly prohibits property-level assessment. Northern Ireland publishes
122 line segments that carry one attribute. None of these products is interchangeable with England's.
A positive-only check would pass on an artifact that reported the entire country as designated.

Distances are measured to the **edge** instead of to the nearest vertex. A point a centimeter from a
long edge can be meters from every vertex of that edge, and measuring to vertices would make the
boundary tolerance far stricter than its stated value.

## Consumer

The reader runs on the geocode path only, after the resolver has produced a coordinate.
`mailwoman/observations`' `createCoastalErosionRoute` turns one reading into an additive
`authority_designation` marker with `mechanism: layer:coastal_erosion`. It is the third rule in the
`layer` family. **The route is off by default and turns on when
`$MAILWOMAN_DATA_ROOT/db/coastal/coastal-england.db` exists.** The file's presence is the only switch. Without the
layer file the route does not run, and the geocode result is byte-identical to a build without the
field.

The artifact is named for its **extent** instead of its subject, because products for other extents
are not interchangeable with it. A file called `coastal.db` would invite a Welsh or Scottish product
to overwrite an English one.

## License and posture

The data is OGL v3.0, with the published attribution string
`© Environment Agency copyright and/or database right 2025. All rights reserved.` OGL makes this
string a license **condition**. Both services report `<Fees>NONE</Fees>`, and neither requires
registration or a key. `tier: shipped`.

The workspace publishes with every release from `.release-it.json`'s workspace list.
