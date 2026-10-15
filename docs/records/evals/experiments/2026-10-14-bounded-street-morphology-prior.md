---
title: "The street-morphology prior bounded to a trailing affix on a numbered segment — graded against production"
description: The bounded form of the street-morphology emission prior, zeroed since #1315, measured through three bounds on the regression board and the golden dev split, with the two bounds that failed and the one that ships default-on.
---

# The street-morphology prior bounded to a trailing affix on a numbered segment — graded against production

The street-morphology emission prior biases a street-type affix the morphology FST accepts toward
`street_prefix` and `street_suffix`, and the words beside it toward `street` and away from
`dependent_locality`. The runtime pipeline has passed it zeroed weights since 426379e4dd, because #1315
measured the unbounded prior at 48 rows down on the US golden set. #2562 found that the prior at its own
weights is the one option that moves the four Rockefeller Plaza rows. The venue-head guard of #2567 left
those rows reading `Rockefeller Plaza` as a venue. This record grades three bounds on that prior. The third
ships default-on in the geocode session as `streetMorphologyPrior`, with `--no-street-morphology-prior`
and the dev MCP pin `street_morphology_prior` to turn it off.

## Inputs

| input   | value                                                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prior   | `buildStreetMorphologyEmissionPriors` with `numberedSegmentOnly`, weights `biasScale` 1 and `dependentLocalityPenalty` 2 (`NUMBERED_MORPHOLOGY_OPTS`), against the zeroed production weights                                  |
| Weights | Shipped en-US 10.3.0 on both arms, through the dev MCP's board-routed path with every locale's overlay                                                                                                                        |
| Board   | The 1,277-row regression board, corpus `11fe8cc55801` before the four rows' status moved                                                                                                                                      |
| Golden  | `data/eval/golden/v0.1.3/dev`, 4,255 rows (US 2,660, FR 1,546, adversarial 49), diffed by `mwdev_compare` and graded against component truth row by row with a scratch script, since the compare tool grades coordinates only |
| Date    | 2026-10-14, git head ce08a5b6e with the branch `fix/2562-bounded-street-morphology` uncommitted                                                                                                                               |

## Bound 1: the segment opens with a digit word

The first bound fired an affix match only when its segment opened, before the match, with a word that
contained a digit. The board read 18 of 1,277 rows changed, 4 improved and 0 regressed. The four improved
rows are `30`, `1`, `10` and `45 Rockefeller Plaza`, which parse as street plus suffix and reach their
address points. Four neutral rows lost a component with the coordinate unchanged: `10 1/2 GRANTS PEN ROAD,
KINGSTON 8, Jamaica` and `7 HILLVIEW AVENUE, KINGSTON 10, Jamaica` lost `KINGSTON` as locality, and
`117 CORONATION AVENUE, GREENDALE, HARARE, Zimbabwe` and `10 EDISON CRESCENT,GRANITESIDE, HARARE, Zimbabwe`
lost their dependent locality. The neighbor pass biased the word after the affix across the comma toward
`street` and away from `dependent_locality`.

## Bound 2: the neighbor stays in the affix's segment

The second bound kept the neighbor bias inside the affix's segment, for the bounded and the unbounded
prior alike. The board read 14 of 1,277 changed, 4 improved and 0 regressed, with the Kingston and Harare
rows unchanged. The golden dev split read 121 of 4,255 rows changed, and against component truth 27 rows
moved toward it and 89 away. All 72 FR rows that changed moved away: `3160 Route de Lagravade,
Sainte-Livrade-sur-Lot 47110` split into `street_prefix` `Route` and street `de Lagravade`, where the FR
truth keeps `Route de Lagravade` whole. The 16 US rows that moved away showed two more mechanisms. The word
after a trailing affix took the street bias, so `05161 Cider Mill Rd VT` merged into one street and
`10TH AVE NE, ND 58078` lost `NE` from its suffix. An affix inside the name fired, so `05350 VT State Rte 100`
split at `Rte`.

## Bound 3: a trailing affix, suffix only, name before it only

The third bound fires only when the affix closes a segment that a digit word opens, biases the suffix
reading only, and places the street bias on the word before the affix only. The unbounded prior keeps its
shape for both readings and both neighbors, inside the segment.

| measurement                   | changed    | toward truth | away from truth |
| ----------------------------- | ---------- | -----------: | --------------: |
| regression board, coordinates | 8 of 1,277 |            4 |               0 |
| golden dev, components        | 6 of 4,255 |            5 |               1 |

The four improved board rows are the Rockefeller Plaza rows. The four neutral board rows split a suffix the
row already held in one piece, with the coordinate unchanged: `Newington Causeway`, `Queens Quay`,
`MetroTech Center` and `JUMEIRAH LAKE TOWERS`. The six golden rows are all US and FR reads zero changes.
`82435 WY Johnson Ave`, `340 Mad River Park` twice, `1501 Deer Park Ave` and `8402 RALLY RUN CIR` move to
the split the truth holds. `Donna Hager, 2307 Twin Oaks, Orange, TX 77630` moves away: `Oaks` is an FST affix
and closes the numbered segment, and the truth keeps `TWIN OAKS` whole. That row is the cost of the bound
on this split.

The venue controls hold on every bound: `Rockefeller Center, 45 Rockefeller Plaza, New York, NY 10111`
keeps its venue and reaches the address point, and `Pier 39, San Francisco, CA 94133`,
`101 Hall Professional Center, Kyle, TX 78640` and `3 World Trade Center, New York, NY 10007` are unchanged.

## What the promotion battery measures

`mwdev_promotion_eval` grades a weights package through `createScorer` in `@mailwoman/neural`, which wires
no street-morphology matcher and no venue-head lexicon. The battery is unchanged by this switch by
construction, and the golden dev comparison above is the component-level measurement of the geocode path
the switch changes.

## Decision

The trailing-affix bound ships default-on in the geocode session. On the board it improves 4 of 1,277 rows
and regresses none, and on the golden dev split it moves 5 US rows toward the truth and 1 away with FR
untouched, so GB, FR, DE and US each regress on zero rows, as the D-rule requires. The four Rockefeller Plaza board rows move from
`improvement_target` to `pass`. The structural-validity sweep keeps them listed, because it parses
with the classifier and no prior. The core runtime pipeline that the API and the browser runtime call
keeps the zeroed weights. That pipeline runs without the venue-head prior as well, and its own grade is
a separate change.

The remaining #2562 rows, `1 Dag Hammarskjold Plaza`, `1 Hammarskjold Plaza`, `2 MetroTech Center` and
`4 Embarcadero Center`, pass since #2567. The `mwdev_compare` tool reports `dataRoot` as an undeclared
difference between two arms whose effective config both read `/mnt/mw`, on every run above. The warning is
a tool defect rather than a second variable.
