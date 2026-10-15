---
title: "The venue-head prior bounded by the country's street types and country names — graded on the board and the golden dev split"
description: Why the venue-head prior read a trailing directional or street type on a bare US street as a venue head, the two guards that close it, and their grade on the regression board, the golden dev split through the runtime pipeline and the geocode session, and the promotion battery.
---

# The venue-head prior bounded by the country's street types and country names — graded on the board and the golden dev split

The record of #2573 measured the venue-head prior at 57 US golden dev rows moved away from the
component truth, every one a bare street whose trailing directional or street type read as a venue
head, and the same reading in the geocode session (#2575). This record traces the mechanism, grades
two guards on the prior, and moves the runtime pipeline's venue-head default to `"auto"`.

## Inputs

| input   | value                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weights | The shipped en-US package 10.3.0, model card 10.1.0, `model.onnx` md5 `0f7de7042a1a888d6cbc201c768e9f00`                                                             |
| Golden  | `data/eval/golden/v0.1.3/dev`, 4,255 rows, through `createRuntimePipeline` with `venueHead: "auto"`, graded row by row against component truth with a scratch script |
| Board   | The 1,277-row regression board through two worktree arms, main 2fdd25604 against the branch, with every session default on                                           |
| Battery | `mailwoman eval promote --check v9.0.0-base` on the branch, against the run of #2573 on main                                                                         |
| Date    | 2026-10-15                                                                                                                                                           |

## The mechanism

The prior's affix guard reads `isStreetAffix` from the sealed street-morphology FST. That FST is built
from libpostal's `street_types.txt` with a minimum variant length of 3, because the one- and two-letter
variants hold US state codes such as `or` and `nd`. It therefore accepts `street`, `road` and `ave` and
rejects `st` and `rd`. The US venue-head table holds `st` as a first-word head at 2.46, the `St` of
`St Mary's Church`, and `school` as a last-word head at 2.68. It holds no entry for `rd`, `sw` or `ne`.

Two readings follow. In `6th St SW, ND`, `St` takes the first-word bias and the extension spreads it to
`SW`, so the decoder reads `6th St` as the street and `SW` as a venue. In `Mountain School Rd, VT`, the
guard that skips a head before a street type does not fire for `Rd`, so `School` takes its last-word
bias and the extension reaches `Mountain`. In `United States of America, Vermont, …`, `america` is a
last-word head from names such as `Bank of America`, and the extension reads `of America` as a venue.

## The guards

The codex gains `streetTypeWordTestFor(country)`, a table of each country's own street-type tests, the
USPS suffixes and directionals for the US, the voie types for France, the thoroughfare types for Great
Britain, Germany and Canada. `venueHeadOptsFor` in `packages/mailwoman/lib/geocode/parse-priors.ts`
combines it with the FST's test and adds the codex's country-name test. Every path that feeds the
lexicon passes both: the session, the gauntlet harness, the runtime pipeline and the battery legs.

In the prior, a street type takes the first-word bias only when it opens its segment, so `St Mary's
Church` keeps it and `6th St SW` does not. A segment whose words are a country name holds no head, so
`United States of America` keeps its country reading and `Bank of America` keeps its venue.

## The golden dev split, each arm against the pipeline without a venue-head lexicon

The before arm is the pipeline with the street-morphology prior and no venue-head lexicon. Each row
below adds the venue-head prior in one form.

| venue-head prior           | changed | toward truth | away from truth | exact rows |
| -------------------------- | ------: | -----------: | --------------: | ---------: |
| before, without a lexicon  |         |              |                 |      2,525 |
| as shipped                 |     366 |           19 |              57 |      2,495 |
| with the street-type guard |     321 |           13 |              28 |      2,512 |
| with both guards           |     298 |           14 |               5 |      2,522 |

Every row that moves away is in `us.jsonl`. With both guards the five are `ST JOHNSBURY ATHENAEUM,
1171 MAIN ST, ST JOHNSBURY, Vermont`, where `St Johnsbury` opens its segment and reads as a venue
head, `John Leppman, 1 Hospital Ct Springfield Medical Care Systems, Bellows Falls VT` and
`CHRISTOPHER ZUMWALT, DEPARTMENT OF SURGERY 1301 N COLUMBIA RD STOP 9037, GRAND FORKS, North Dakota
582029037`, where the street loses a word, and `North Dakota Menasha Center` and `Guilford Centre,
Vermont, US`, localities whose last word is a venue head. The 14 rows that move toward the truth
include non-Latin rows the grade counts by fewer disagreeing tags while the parse stays wrong, so the
count overstates the rows the prior improves.

The geocode session reads the same way. The 12 rows of run `27d8b991-890a-4337-9f32-f6a7891b8dc1`,
of which 11 differed with the prior on, differ on 1 with both guards (run
`dea9da2f-0ba7-459f-b38d-5326eac6b2e2`): `The Manchester Art Gallery, Manchester`, where the prior
reads `Art Gallery` as the venue. `6th St SW, ND` reads as the street `6th St SW`, `Mountain School Rd,
VT` as the street `Mountain School` with suffix `Rd`, and `500 W 7th St Ste 1100, Cincinnati, OH
45203-1234` keeps its address point.

## The board and the battery

The board through two worktree arms (run `98614b3b-4de0-4e59-9a1d-b0b9d2978977`): 0 of 1,277 rows
differ at any threshold, 459 of 756 rows within 1 km on both arms, and one tier change,
`Donkey's Place Downtown, 37 Washington St Rear, Mt Holly, NJ 08060`, from the venue tier at 24 m to
the address point at 52 m, both inside the row's 150 m tolerance. FR, GB and DE rows are unchanged.

The `v9.0.0-base` battery on the branch reads `PASS` on all 18 floors, as the #2573 run on main did.
Four floors move: `us.micro` from 86.7 to 87.1, `us.locality` from 86.9 to 86.8, `us.region` from 89.8
to 89.7 and `us.street` from 77.9 to 77.6, each inside its floor's margin. The per-locale leg scores
a tag's F1 rather than a row, so a bare street that reads as one street span where the key splits
its suffix moves `us.street` without moving the row grade above.

## Decision

Both guards ship on every path, and `createRuntimePipeline` reads the venue-head lexicon by default,
as the geocode session does. On the golden dev split the prior now moves 14 rows toward the truth and
5 away, with the exact-row count 3 under the arm without it, and on the board it changes no row. The
five rows above are the prior's remaining cost on this split. The sealed morphology FST still omits
the two-letter street types, so the street-context check and the street-morphology prior read `St`
and `Rd` as names. That is a separate change to the FST build and its collision guard.
