---
title: "The Empire State Building pair — an exact POI row outranks a partial name, decorated rows break a two-row tie, and a bare landmark reaches the POI layer"
description: The two Empire State Building board rows of #2570, with the venue-tier mechanism that sent the city form to a Brooklyn office and the admin race that sent the bare form to Empire, California, the three changes to the fork-entity probes, their cost on poi.db, and the regression board graded against main.
---

# The Empire State Building pair — an exact POI row outranks a partial name, decorated rows break a two-row tie, and a bare landmark reaches the POI layer

`Empire State Building` resolved to 37.644839, -120.902851, the locality Empire in Stanislaus County,
California. `Empire State Building, New York, NY` resolved through the venue tier to a
`government_office` row with the name `State Building` at 40.685626, -73.97563 in Brooklyn. Both rows sit on the
regression board as `us-landmark-empire-state-building-bare` and `-city` with the Midtown row
40.749143, -73.986621 as truth at 200 m (#2570). This record traces both, grades the three changes to
`packages/mailwoman/lib/fork-entity.ts`, and measures the probe they add.

## Inputs

| input    | value                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weights  | The shipped en-US package 10.3.0, model card 10.1.0, `model.onnx` md5 `0f7de7042a1a888d6cbc201c768e9f00`                                                                   |
| POI rows | `poi.db` of 2026-10-14, searched for `Empire State Building` with limit 24 and for `State Building`                                                                        |
| Board    | The 1,277-row regression board, corpus `4705217ca3e5` before the two rows' status moved, through `mwdev_compare` with two worktree arms, main 48285206a against the branch |
| Date     | 2026-10-15                                                                                                                                                                 |

## The city form

The parse reads `Empire State Building` as a venue, `New York` as the locality and `NY` as the region,
and the locality anchors the venue tier at the New York centroid with the 30 km radius. `poi.db` holds two
exact rows under the key `empire state building`: the Midtown row at 40.749143, -73.986621 with
confidence 0.951, and an Upper East Side row at 40.7807201, -73.9608153 with confidence 0.972, 3.7 km
apart. Both sit inside the radius. `probeVenueNearAnchor` answered only when one exact row sat inside the
radius, so it abstained, the head-folding retry found no head to fold, and the retry without the leading
word searched `State Building` and found one row inside the radius, the Brooklyn office. The venue tier
took it.

Two changes close this. An exact row inside the radius now outranks every partial-name reading: when
exact rows are present and the exact probe abstains among them, neither retry runs. And several exact
rows are read by the rows that decorate the name. The search returns four rows whose names contain
`empire state building` without equaling it, `Empire State Building - 102nd Floor`, `Virgo Business
Centers at The Empire State Building`, `Hampton Inn Manhattan-35th Street and Empire State Building` and
`Bounce Luggage Storage - Near Empire State Building`, and every one sits within 1 km of the Midtown
row and none within 1 km of the Upper East Side row. The exact row with the most decorated rows within
1 km wins when it holds that maximum by itself. A tie, or no decorated row beside any exact row, abstains
as before, so two branches of one chain under one anchor stay an admin answer.

## The bare form

The parse reads `Empire State` as a locality and `Building` as a region, with no venue span. The flat
component map keeps `Empire` as the locality, the resolver finds no region `Building` and no locality
`Empire State`, and the span rescore picks the locality Empire in California. The kind classifier reads
the input as `landmark` at 0.88, and that verdict never reached the POI layer. The fork-entity probe
would have refused the name anyway, because the morphology FST accepts `building` as a street type and
the probe's street-type guard refuses a name that holds one.

The change runs a guard-free exact probe, `probeLandmarkEntity`, on the whole input when the kind verdict
is `landmark`, the parse produced no venue span, and no resolved node's value equals the whole input.
The last condition keeps a bare name the admin race resolved whole, such as a locality whose name is all
of its words, on its admin answer. A hit rewrites the result as the entity: the parse's components and the
hierarchy the resolver built from them describe a place the input does not state, so they are cleared and
the component map holds the venue. The probe reads the same two exact rows and the same decorated rows
as the city form, and the Midtown row wins.

## The probe's cost

Each name ran 20 times through `probeLandmarkEntity` on the full `poi.db` in one process, after the
first call warmed the connection.

| input                 |  median |     max | answer                       |
| --------------------- | ------: | ------: | ---------------------------- |
| Empire State Building |  3.3 ms | 16.4 ms | Midtown row                  |
| Rockefeller Center    |  9.2 ms | 31.7 ms | 40.758981, -73.979232        |
| Lincoln Center        | 12.5 ms | 29.3 ms | abstains, several exact rows |
| Buckingham Palace     |  0.7 ms |  1.4 ms | 51.500274, -0.14507          |
| Golden Gate Bridge    |  1.4 ms | 12.9 ms | abstains, several exact rows |
| Pier 39               |  0.4 ms | 13.4 ms | 37.807910, -122.418615       |

The probe runs for the `landmark` kind only, two to four proper-case words in one segment with no
house number and no disqualifying street suffix. A one-word chain name such as `Starbucks` never
reaches it. That name costs the fork probe 147 ms at the median and 3.2 s at the maximum on the same
database. That is the cost a wider trigger would pay.

## Grades

The board through two worktree arms, main against the branch, on 1,277 rows (run
`48af0e57-2df8-4be3-b6b3-225f42cf484e`):

| measure                            | main | branch |
| ---------------------------------- | ---: | -----: |
| rows that differed                 |      |      2 |
| graded improved at 25 km           |      |      1 |
| graded regressed at 25 km          |      |      0 |
| rows within 1 km of truth, of 756  |  457 |    459 |
| rows within 25 km of truth, of 756 |  600 |    601 |

The two rows that differed are the two Empire State Building rows. The bare row moves from 4,009 km to
the truth point and the city row from 7.1 km to the truth point. Every FR, GB and DE row is unchanged,
as the D-rule requires. The `v9.0.0-base` battery on the shipped weights is unchanged by construction,
because its legs parse and never reach the venue tier: it reads the same 17 of 18 floors before and after
the branch, with `us.region` at 88.9 under the 89.4 floor on both, the reading #2573 attributes to the
battery feeding no prior.

## Decision

The three changes ship. The two board rows move from `improvement_target` to `pass`. The corroboration
read is the one new rule: it is bounded to exact rows under one name, it abstains on a tie, and the
decorated rows it counts come from the search the probe already runs, so it adds no query.
