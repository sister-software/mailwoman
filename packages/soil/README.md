# `@mailwoman/soil`

USDA NRCS SSURGO soil survey as a sealed spatial layer: acquisition, the `soil.db` build, and its reader.

The layer answers one question — **what does the soil survey assign to the map unit covering this
location** — and it answers it as a distribution rather than as a class. That shape is not a preference;
it is what three measurements force.

## What it stores, and why it is a distribution

| measurement                                                                 |                         figure |
| --------------------------------------------------------------------------- | -----------------------------: |
| national map units holding two or more components                           | 284,777 of 339,191 (**84.0%**) |
| map units where the largest component covers under half of it               |             57,053 (**16.8%**) |
| `IA153` delineations smaller than one resolution-9 cell                     |   15,350 of 17,966 (**85.4%**) |
| NRCS's own dominant-condition share `muaggatt.niccdcdpct`, observed minimum |                         **2%** |

No affordable cell size removes the mixture, because the mixture is the survey's own finding: 128,499
map units (38.0%) are complexes, associations or undifferentiated groups, which is NRCS stating that the
soils are intermingled and cannot be separated at the mapping scale. NRCS itself ships its
dominant-condition class beside the share that class covers. `soil_capability_cell` reproduces that
pattern at cell grain.

**One artifact, two consumers.** A result-level observation reads `top_class` with `top_class_share`;
a bulk per-cell signal reads `class_shares` plus the four absence shares as one axis. One acquisition,
one aggregation, one set of provenance rows, and no way for the two to disagree about what the ground is.

## Four absences, and the one positive negative

An absence is never represented by a small number. Five readings a consumer can tell apart:

| reading                                              | where it lives                                     |
| ---------------------------------------------------- | -------------------------------------------------- |
| the survey rated this land as precluding cultivation | class `"8"` in `class_shares` — a determination    |
| the survey did not rate it                           | `unrated_share`                                    |
| the rating does not apply to it (rock, water)        | `notrateable_share`                                |
| the polygon exists, the soil mapping does not        | `nodata_share` (`NOTCOM`, `NOTPUB`, access denied) |
| there is no survey here at all                       | **no `layer_coverage` row, and no summary row**    |

Class 8 is a determination and is a class share like any other. Folding it in with the others produces a
well-formed wrong answer, and 67,547 national components carry it. The irrigated rating makes the point
again at larger scale: `irrcapcl` is NULL on 85.1% of national components because it is populated only
where irrigation is a considered use, so it is carried and never reduced.

`other_share` carries the truncated minority tail, so the five shares always sum to 1 and a reader can
see how much was folded away rather than inferring it from a gap. `mapped_share` says how much of the
cell any delineation covers at all — without it, a survey-area edge cell's unmapped remainder would
silently deflate every class share.

## The resolution, measured

The index resolution is a measurement, not an argument. Measured on `IA153` — 17,966 delineations over
1,532.5 km², median delineation 24,863 m²:

| res | touched cells |  whole | partial | partial share | whole after compaction | (cell, delineation) pairs | mean delineations/cell | top class under half |
| --- | ------------: | -----: | ------: | ------------: | ---------------------: | ------------------------: | ---------------------: | -------------------: |
| 7   |           348 |      0 |     348 |    **100.0%** |                      0 |                    24,073 |                  69.18 |            **44.4%** |
| 8   |         2,237 |      9 |   2,228 |     **99.6%** |                      9 |                    36,569 |                  16.35 |            **39.8%** |
| 9   |        15,136 |    369 |  14,767 |     **97.6%** |                    315 |                    80,956 |                   5.35 |            **30.7%** |
| 10  |       104,508 | 13,691 |  90,817 |     **86.9%** |                 11,537 |                   268,408 |                   2.57 |            **18.2%** |

**The `partial` share inverts against the flood layer, exactly as the survey predicted, and the inversion
is total.** Flood polygons are large against their cells, so most cells fall wholly inside one zone and
`compactCells` collapses long uniform interiors. Soil delineations are the opposite, so **the containment
index answers almost no probe on its own at any candidate resolution**, and compaction yields close to
nothing: at resolution 9, 369 whole cells compact to 315 — a 14.6% reduction, against a flood layer whose
interiors collapse by orders of magnitude. At resolution 7 it collapses zero of zero.

That is why this layer carries the reduced `soil_capability_cell` **alongside** the index rather than
relying on the index the way the flood layer can. The unsimplified geometry is still the truth and is
still what the reduction weights by; it is not what answers a probe.

**The two numbers move in opposite directions, and only one of them discriminates.** The `partial` share
is 87–100% at every candidate, so it cannot choose a resolution here — which is itself the finding. The
mixture number can, and it is the one the choice rests on.

**Resolution 9 is the choice.** It is where `poi.db` keys its rows, so a reader already holding another
layer's cells finds these without a conversion; its mixture share (30.7%) is well inside the range the
authority's own aggregation lives in; and resolution 10 costs 6.9× the cells (104,508 against 15,136 for
one county) to move the mixture from 30.7% to 18.2%, and leaves 5.2% of its cells carrying no class at all against
2.7% at resolution 9. Resolution 11 was excluded before measuring: it
would leave 2.1% of `IA153`'s delineations sub-cell at roughly 49× the resolution-9 cell count.

For comparison, NRCS's own map-unit-grain `niccdcdpct` reads below half on 3.3% of national map units.
Aggregating to a resolution-9 cell multiplies that roughly ninefold, which is the cost of the cell grain
stated as a number rather than as a worry.

## Acquisition

- **Soil Data Access** (`sdmdataaccess.nrcs.usda.gov/Tabular/post.rest`) — the survey-area catalogue and
  the point-intersection check, through `APIClient`. Anonymous, no key, measured at 0.374 s for a tabular
  answer and 1.807 s for a point intersection.
- **Survey-area archives** (`websoilsurvey.sc.egov.usda.gov/DSD/Download/Cache/SSA`) — file transfers on
  raw `fetch`, streamed to disk, saying so in place.

Three measured behaviours the code is written against:

1. **Failures come back as XML, including on a timeout.** A bad column, a blocked query and a
   server-side timeout all return an OGC `ServiceExceptionReport`, and the timeout arrives on an HTTP 200.
   Every response is read as text and checked for the report before anything parses it as JSON.
2. **The download host answers `HEAD` with 405 and ignores `Range`.** A request with `Range: bytes=0-0`
   returned HTTP 200 and transferred the whole 27,598,377 bytes. Freshness comes from
   `sacatalog.saverest`, which is also what the archive's filename embeds. A wrong date is an HTTP **400**,
   not a 404.
3. **The tabular export carries embedded newlines.** `sacatlog.txt` holds 594 newline bytes and exactly
   ONE record, because `fgdcmetadata` is a 43,251-character XML document; `mstabcol.txt` — the column
   dictionary itself — holds 913 newlines and 865 records. The reader is quote-aware end to end.

**The archive ships its own schema and its own vocabulary.** `mstab.txt` maps a logical table to the file
that holds it (`component` → `comp.txt`; neither is guessable), `mstabcol.txt` gives every column's
position, and `msdomdet.txt` carries each `Choice` column's declared members **with NRCS's own prose
definition** — capability classes 1 through 8, subclasses `c`/`e`/`s`/`w`, the 28 conditional farmland
classifications, the six component kinds. The layer reads its domain out of the file it ingested rather
than transcribing it, stores it in `soil_vocabulary`, and throws on a value outside it.

## License, and where the grant comes from

data.gov's entry carries `usa.gov/publicdomain/label/1.0/`, which redirects to a page that declines a
blanket grant and tells the reader to check with the agency. The agency was checked at the strongest
available place — **the FGDC metadata NRCS ships inside every archive** — and its use constraints say:

> This is public information and may be interpreted by organizations, agencies, units of government, or
> others based on needs; however, they are responsible for the appropriate application.

The build asserts that sentence is present **per survey area**. An area whose use constraints no longer
carry it is a license change, and a build that absorbed one would ship an artifact under terms nobody
checked. The acknowledgement the same metadata asks for rides in `layer_manifest.attribution`:
_U.S. Department of Agriculture, Natural Resources Conservation Service._

## Two dates, and they are not the same fact

`sacatalog.saverest` is the refresh. NRCS runs ONE coordinated Annual Soils Refresh each October 1, and
grouping the catalogue by year returns 2016: 1, 2025: 3,323, 2026: 56 — so a region's areas share a
vintage. **The field survey underneath is far older.** `IA153` carries a 2025-09-09 refresh over a
_Soil Survey of Polk County, Iowa_ published in **1960** at 1:15,840, and the dataset's own
time-period-of-content ends at the refresh. A consumer reading that as survey currency reads it wrong by
sixty-five years.

Both dates are stored per survey area, apart, with the title the older one came from so it is checkable.
Two scales are kept apart for the same reason: `legend.projectscale` (12,000 for `IA153`) is the scale the
map units were digitized at; the source citation's own `srcscale` (15,840) is the scale the ground was
walked at.

## What a reading may claim

> the soil survey assigns this capability class to the map unit covering this location

and never

> this land can (or cannot) be farmed.

NRCS says the second reading is wrong, in the metadata it ships: the data "do not eliminate the need for
onsite sampling, testing, and detailed study of specific sites for intensive uses. Thus, these data and
their interpretations are intended for planning purposes only." Every reading carries the product's own
limits for that reason.

**The farmland vocabulary is conditional, and two of its categories do not travel.** 24 of its 28 declared
values carry an "if" — `Prime farmland if drained`, `Prime farmland if irrigated and reclaimed of excess
salts and sodium` — so the string is stored whole; a boolean `arable` column would be this layer's
invention. And 7 CFR 657.5 defines prime and unique farmland nationally while §657.5(c) and (d) hand
statewide and local importance to state and local agencies, so `Farmland of statewide importance` in Iowa
and in Georgia are not the same claim. `soil_map_unit.farmland_scope` carries that distinction into the
artifact.

## Building

```bash
# The smoke rung: one real survey area, end to end.
mailwoman gazetteer build soil --area IA153 --verify

# The pilot: every published Iowa survey area.
mailwoman gazetteer build soil --region IA --verify

# The resolution measurement. Reports a table, not an artifact.
mailwoman gazetteer build soil --area IA153 --measure-resolutions 7,8,9,10
```

The build is bounded by construction: one child process per range of a survey area's own FIDs, because
h3's WASM heap cannot be reset from JavaScript and reports an exhausted allocator as a successful empty
answer. A per-part zero-cell guard refuses that answer; the process bound is what makes the build
reproducible. Both live in `@mailwoman/spatial`'s `h3/polygon-cells.ts`, shared with `@mailwoman/flood`,
because the traps are properties of h3-js rather than of either product.

## Verification

`--verify` runs both halves. The positive half re-asks Soil Data Access which map unit covers a sample of
points drawn deterministically from the artifact, comparing **map unit against map unit** — comparing the
derived class instead would let a wrong delineation agree by accident whenever two neighbours share a
class. Disagreements carry the distance to the nearest **edge**, not to the nearest vertex: a point a
centimeter from a long edge can be meters from every vertex, and the flood layer's one near-miss read
1.58 m to vertices and 0.009 m to edges.

The negative half samples points in every neighboring state, two of them close to the Iowa border, and
requires `unknown` — no coverage row — rather than a low-capability reading. The positive half alone would
pass on an artifact that answered class 8 for the whole planet.

## The observation

Default OFF, and the switch is the presence of `$MAILWOMAN_DATA_ROOT/soil/soil.db` rather than a boolean.
The reading reaches a caller as one additive `QueryIntentMarker` with `code: "authority_designation"` and
`mechanism: "layer:soil_capability"` — the same code the flood layer's marker uses, under the same `layer`
family, with a rule of its own. The class never travels without the share it rests on. Ranking, abstention
and every existing result field are unchanged, and a test pins that a geocode without the layer is
byte-identical to one with it, minus the marker.

## Not this layer's job

- **No raster in the database.** gSSURGO and gNATSGO are the gridded derivatives at 10 m per state and
  30 m for CONUS, in a projected CRS, distributed through a host that refuses anonymous programmatic
  download. Should a builder reach for one, the raster rule applies: bin at build time to the same
  per-cell class summary shape and store that, never the grid.
- **No Cropland Data Layer.** It is CC0 and measured, but it answers a different question — observed cover
  in one season, not capability — its accuracy caveats are unread, and it is a raster ingest into a
  repository with no raster tooling. Whoever does build it inherits a meaning-of-zero inversion that
  arrives pre-built in the source's own encoding: the derived Crop Frequency Layer's value domain runs
  `"1"` planted once in 18 years through `"18"` planted every year, then **`"255"` planted ZERO times**,
  while **`"0"` is No Data**. A reader that takes 0 as "never planted" reads _we have no data here_ as
  _nothing was ever grown here_ — exactly backwards. Nothing in this vocabulary uses a numeric sentinel
  for either state, and nothing in it should start.
- **No suitability score.** The layer repeats what an authority states, in the authority's vocabulary, with
  the authority's dates. The projection to a number belongs to the consumer, not to the layer.
