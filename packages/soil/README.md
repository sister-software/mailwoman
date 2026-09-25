# `@mailwoman/soil`

This package provides the USDA NRCS SSURGO soil survey as a sealed spatial layer. It covers acquisition,
the `soil.db` build, and the reader.

The layer answers one question: **what does the soil survey assign to the map unit covering this
location?** It answers with a distribution instead of a single class, because three measurements require
that shape.

## What it stores, and why it is a distribution

| measurement                                                                 |                         figure |
| --------------------------------------------------------------------------- | -----------------------------: |
| national map units holding two or more components                           | 284,777 of 339,191 (**84.0%**) |
| map units where the largest component covers under half of it               |             57,053 (**16.8%**) |
| `IA153` delineations smaller than one resolution-9 cell                     |   15,350 of 17,966 (**85.4%**) |
| NRCS's own dominant-condition share `muaggatt.niccdcdpct`, observed minimum |                         **2%** |

No affordable cell size removes the mixture, because the mixture is the survey's own finding. 128,499
map units (38.0%) are complexes, associations or undifferentiated groups. With those designations NRCS
states that the soils are intermingled and cannot be separated at the mapping scale. NRCS itself ships its
dominant-condition class beside the share that class covers, and `soil_capability_cell` reproduces that
pattern at cell grain.

**One artifact serves two consumers.** A result-level observation reads `top_class` with
`top_class_share`. A bulk per-cell signal reads `class_shares` plus the four absence shares as one axis.
Both come from one acquisition, one aggregation, and one set of provenance rows, so the two consumers
cannot disagree about the ground.

## Four absences, and the one positive negative

The layer never represents an absence with a small number. A consumer can tell apart five readings:

| reading                                              | where it lives                                     |
| ---------------------------------------------------- | -------------------------------------------------- |
| the survey rated this land as precluding cultivation | class `"8"` in `class_shares`, a determination     |
| the survey did not rate it                           | `unrated_share`                                    |
| the rating does not apply to it (rock, water)        | `notrateable_share`                                |
| the polygon exists, the soil mapping does not        | `nodata_share` (`NOTCOM`, `NOTPUB`, access denied) |
| there is no survey here at all                       | **no `layer_coverage` row, and no summary row**    |

Class 8 is a determination and is a class share like any other. Merging it with the absence readings
produces a well-formed wrong answer, and 67,547 national components carry it. The irrigated rating shows
the same problem at a larger scale. `irrcapcl` is NULL on 85.1% of national components because it is
populated only where irrigation is a considered use, so the layer stores it and never reduces it.

`other_share` carries the truncated minority tail, so the five shares always sum to 1, and a reader can
see how much was folded away without inferring it from a gap. `mapped_share` says how much of the cell
any delineation covers. Without it, the unmapped remainder of a cell at a survey-area edge would silently
shrink every class share.

## The resolution, measured

The index resolution was chosen by measurement. The measurements below come from `IA153`, which has
17,966 delineations over 1,532.5 km² and a median delineation of 24,863 m²:

| res | touched cells |  whole | partial | partial share | whole after compaction | (cell, delineation) pairs | mean delineations/cell | top class under half |
| --- | ------------: | -----: | ------: | ------------: | ---------------------: | ------------------------: | ---------------------: | -------------------: |
| 7   |           348 |      0 |     348 |    **100.0%** |                      0 |                    24,073 |                  69.18 |            **44.4%** |
| 8   |         2,237 |      9 |   2,228 |     **99.6%** |                      9 |                    36,569 |                  16.35 |            **39.8%** |
| 9   |        15,136 |    369 |  14,767 |     **97.6%** |                    315 |                    80,956 |                   5.35 |            **30.7%** |
| 10  |       104,508 | 13,691 |  90,817 |     **86.9%** |                 11,537 |                   268,408 |                   2.57 |            **18.2%** |

**The `partial` share is the reverse of the flood layer's, as the survey predicted, and the reversal is
complete.** Flood polygons are large relative to their cells, so most cells fall wholly inside one zone and
`compactCells` collapses long uniform interiors. Soil delineations are small relative to their cells, so
**the containment index answers almost no probe on its own at any candidate resolution**, and compaction
saves almost nothing. At resolution 9, 369 whole cells compact to 315, a 14.6% reduction, while the flood
layer's interiors collapse by orders of magnitude. At resolution 7 there are zero whole cells to collapse.

For that reason this layer carries the reduced `soil_capability_cell` **alongside** the index instead of
relying on the index the way the flood layer can. The unsimplified geometry is still stored,
and the reduction weights by it, but probes are answered from the reduced table.

**The two numbers move in opposite directions, and only one of them distinguishes the candidates.** The
`partial` share is 87–100% at every candidate, so it cannot select a resolution here, and that is itself
a finding. The mixture number can select one, and the choice rests on it.

**Resolution 9 is the choice.** `poi.db` keys its rows at resolution 9, so a reader that already holds
another layer's cells finds these without a conversion. Its mixture share (30.7%) is well inside the range
of the authority's own aggregation. Resolution 10 costs 6.9× the cells (104,508 against 15,136 for one
county) to move the mixture from 30.7% to 18.2%, and it leaves 5.2% of its cells carrying no class at all,
against 2.7% at resolution 9. Resolution 11 was excluded before measuring, because it would leave 2.1% of
`IA153`'s delineations smaller than a cell at roughly 49× the resolution-9 cell count.

For comparison, NRCS's own map-unit-grain `niccdcdpct` reads below half on 3.3% of national map units.
Aggregating to a resolution-9 cell multiplies that roughly ninefold, which quantifies the cost of the cell
grain.

## Acquisition

- **Soil Data Access** (`sdmdataaccess.nrcs.usda.gov/Tabular/post.rest`) provides the survey-area
  catalogue and the point-intersection check, through `APIClient`. It is anonymous and needs no key. It
  measured 0.374 s for a tabular answer and 1.807 s for a point intersection.
- **Survey-area archives** (`websoilsurvey.sc.egov.usda.gov/DSD/Download/Cache/SSA`) are file transfers on
  raw `fetch`, streamed to disk. The call site documents that choice.

The code handles three measured behaviours:

1. **Failures come back as XML, including on a timeout.** A bad column, a blocked query and a
   server-side timeout all return an OGC `ServiceExceptionReport`, and the timeout arrives with HTTP 200.
   Every response is read as text and checked for the report before anything parses it as JSON.
2. **The download host answers `HEAD` with 405 and ignores `Range`.** A request with `Range: bytes=0-0`
   returned HTTP 200 and transferred the whole 27,598,377 bytes. Freshness comes from
   `sacatalog.saverest`, which the archive's filename also embeds. A wrong date returns HTTP **400** (and never 404).
3. **The tabular export carries embedded newlines.** `sacatlog.txt` holds 594 newline bytes and exactly
   one record, because `fgdcmetadata` is a 43,251-character XML document. `mstabcol.txt`, the column
   dictionary itself, holds 913 newlines and 865 records. The reader is quote-aware throughout.

**The archive ships its own schema and its own vocabulary.** `mstab.txt` maps a logical table to the file
that holds it (`component` → `comp.txt`, which cannot be guessed). `mstabcol.txt` gives every column's
position. `msdomdet.txt` carries each `Choice` column's declared members **with NRCS's own prose
definition**: capability classes 1 through 8, subclasses `c`/`e`/`s`/`w`, the 28 conditional farmland
classifications, and the six component kinds. The layer reads its domain from the file it ingested instead
of transcribing it, stores it in `soil_vocabulary`, and throws on a value outside it.

## License, and where the grant comes from

data.gov's entry carries `usa.gov/publicdomain/label/1.0/`, which redirects to a page that declines to
make a blanket grant and tells the reader to check with the agency. The strongest available agency
statement is **the FGDC metadata that NRCS ships inside every archive**, and its use constraints say:

> This is public information and may be interpreted by organizations, agencies, units of government, or
> others based on needs; however, they are responsible for the appropriate application.

The build asserts that the sentence is present **per survey area**. If an area's use constraints no longer
carry it, the license has changed, and a build that accepted the change would ship an artifact under terms
nobody checked. The acknowledgement that the same metadata requests is stored in
`layer_manifest.attribution`: _U.S. Department of Agriculture, Natural Resources Conservation Service._

## Two dates, and they are not the same fact

`sacatalog.saverest` is the refresh date. NRCS runs one coordinated Annual Soils Refresh each October 1.
Grouping the catalogue by year returns 2016: 1, 2025: 3,323, 2026: 56, so a region's areas share a
vintage. **The field survey underneath is far older.** `IA153` carries a 2025-09-09 refresh over a
_Soil Survey of Polk County, Iowa_ published in **1960** at 1:15,840, and the dataset's own
time-period-of-content ends at the refresh. A consumer that reads the refresh date as the survey date is
wrong by sixty-five years.

The layer stores both dates separately per survey area, together with the title of the source for the
older date, so a reader can check it. It keeps two scales separate for the same reason.
`legend.projectscale` (12,000 for `IA153`) is the scale at which the map units were digitized. The source
citation's own `srcscale` (15,840) is the scale at which the ground was surveyed.

## What a reading may claim

> the soil survey assigns this capability class to the map unit covering this location

and never

> this land can (or cannot) be farmed.

The metadata NRCS ships says the second reading is wrong. It states that the data "do not eliminate the need for
onsite sampling, testing, and detailed study of specific sites for intensive uses. Thus, these data and
their interpretations are intended for planning purposes only." Every reading carries the product's own
limits for that reason.

**The farmland vocabulary is conditional, and two of its categories mean different things in different
states.** 24 of its 28 declared values carry an "if", such as `Prime farmland if drained` and `Prime
farmland if irrigated and reclaimed of excess salts and sodium`. The layer therefore stores the string
whole, because a boolean `arable` column would be this layer's invention. 7 CFR 657.5 defines prime and
unique farmland nationally, while §657.5(c) and (d) assign statewide and local importance to state and
local agencies. `Farmland of statewide importance` in Iowa and in Georgia are therefore different claims.
`soil_map_unit.farmland_scope` carries that distinction into the artifact.

## Building

```bash
# The smoke rung: one real survey area, end to end.
mailwoman gazetteer build soil --area IA153 --verify

# The pilot: every published Iowa survey area.
mailwoman gazetteer build soil --region IA --verify

# The resolution measurement. Reports a table rather than an artifact.
mailwoman gazetteer build soil --area IA153 --measure-resolutions 7,8,9,10
```

The build bounds its h3 usage by running one child process per range of a survey area's own FIDs. h3's
WASM heap cannot be reset from JavaScript, and it reports an exhausted allocator as a successful empty
answer. A per-part zero-cell guard rejects that answer, and the process bound makes the build
reproducible. Both live in `@mailwoman/spatial`'s `h3/polygon-cells.ts` and are shared with
`@mailwoman/flood`, because the failure modes belong to h3-js and not to either product.

## Verification

`--verify` runs both halves. The positive half asks Soil Data Access again which map unit covers a sample
of points drawn deterministically from the artifact, and it compares **map unit against map unit**.
Comparing the derived class instead would let a wrong delineation agree by accident whenever two
neighbours share a class. Disagreements report the distance to the nearest **edge** instead of the nearest
vertex. A point a centimeter from a long edge can be meters from every vertex, and the flood layer's one
near-miss measured 1.58 m to vertices and 0.009 m to edges.

The negative half samples points in every neighboring state, two of them close to the Iowa border, and
requires `unknown` with no coverage row. A low-capability reading fails the check. The positive half alone would pass
on an artifact that answered class 8 for the whole planet.

## The observation

The observation is off by default. It turns on when `$MAILWOMAN_DATA_ROOT/db/soil/soil.db` exists, and
the file's presence is the only switch. The reading reaches a caller as one additive `QueryIntentMarker` with
`code: "authority_designation"` and `mechanism: "layer:soil_capability"`. The flood layer's marker uses the
same code in the same `layer` family, and this layer has a rule of its own. The class always travels with
the share it rests on. Ranking, abstention and every existing result field are unchanged. A test checks
that a geocode without the layer is byte-identical to one with it, apart from the marker.

## Not this layer's job

- **The database holds no raster.** gSSURGO and gNATSGO are the gridded derivatives at 10 m per state and
  30 m for CONUS, in a projected CRS, distributed through a host that refuses anonymous programmatic
  download. If a builder ever uses one, the raster rule applies: bin it at build time into the same
  per-cell class summary shape and store that summary, never the grid.
- **The layer excludes the Cropland Data Layer.** That product is CC0 and measured, but it answers a
  different question, since it reports observed cover in one season and not capability. Its accuracy
  caveats are unread, and ingesting it would mean a raster ingest into a repository with no raster
  tooling. Whoever builds it will face a reversed meaning of zero in the source's own encoding. The
  derived Crop Frequency Layer's value domain runs from `"1"` (planted once in 18 years) through `"18"`
  (planted every year), then **`"255"` means planted zero times**, while **`"0"` is No Data**. A reader
  that takes 0 as "never planted" reads _we have no data here_ as _nothing was ever grown here_, which is
  the opposite of the truth. This vocabulary uses no numeric sentinel for either state and should not
  start.
- **The layer computes no suitability score.** It repeats what an authority states, in the authority's
  vocabulary, with the authority's dates. Converting that into a number is the consumer's job.
