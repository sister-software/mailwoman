---
title: "The street-morphology FST with two-letter street types — graded old artifact against new"
description: The sealed street-morphology FST rebuilt with two-character variants admitted and the codex's region abbreviations excluded by name, graded as two staged weights caches on the regression board, on the golden dev split through the runtime pipeline, and on the promotion battery.
---

# The street-morphology FST with two-letter street types — graded old artifact against new

The sealed `fst-street-morphology.bin` of 2026-07-26 held no variant shorter than three characters,
so `st`, `rd`, `av`, `dr`, `ln`, `pl` and `sq` were names to the street-context check, the
street-morphology prior and the venue-head prior's affix guard (#2579). The record of #2575 found the
guard reading `St` and `Rd` as name words for that reason. This record grades the rebuilt artifact.

## Inputs

| input   | value                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weights | The shipped en-US package 10.3.0, `model.onnx` md5 `0f7de7042a1a888d6cbc201c768e9f00`, staged twice as package-shaped caches that differ in `fst-street-morphology.bin` only |
| Old     | `/tmp/lab/mailwoman/fst-old`, the artifact built 2026-07-26: 3,637 states, 3,763 variant insertions, 327,516 bytes                                                           |
| New     | `/tmp/lab/mailwoman/fst-new`, the artifact built 2026-10-15: 3,825 states, 4,120 variant insertions, 366,006 bytes, 1,707 canonicals and 60 locales on both                  |
| Golden  | `data/eval/golden/v0.1.3/dev`, 4,255 rows, through `createRuntimePipeline` with its defaults, graded row by row against component truth with a scratch script                |
| Board   | The 1,277-row regression board, board-routed, through `mwdev_compare` with `weights_cache` as the declared variable                                                          |
| Battery | `mailwoman eval promote --check v9.0.0-base` on each cache                                                                                                                   |
| Date    | 2026-10-15, git head 4a205d1b1 with the branch `fix/2579-morphology-fst-short-variants` uncommitted                                                                          |

## The variants admitted and excluded

The libpostal dictionaries hold 220 distinct one- and two-character variants across the 60 locales
that ship a `street_types.txt`. The builder now admits a variant of two characters or more and
excludes, by name, the region abbreviations the codex holds: the 50 US state codes with DC and the
territories, the 8 Australian states and territories, and the 13 Canadian provinces and territories.
Twenty-one dictionary variants are US state codes, among them `ct` for court, `la` for lane, `wy` for
way, `pr` for prospekt and `ri` for rise, and they stay out for every locale. One-character variants
stay out, because `a`, `b` and `c` collide with unit designators.

After the rebuild `isStreetAffix` reads `st`, `rd`, `av`, `dr`, `ln`, `pl`, `sq`, `bd` and `hw` as
street affixes, `ct`, `la`, `wy`, `sa` and `nt` as none, and `a` as none.

## The golden dev split through the runtime pipeline

The before arm is main at 4a205d1b1 with the old artifact in the weights package. The after arm is
the same tree with the new artifact copied in.

| measure                         | before | after |
| ------------------------------- | -----: | ----: |
| rows changed, of 4,255          |        |    30 |
| US rows toward the truth        |        |    20 |
| US rows away from the truth     |        |     5 |
| exact rows, all files           |  2,522 | 2,537 |
| exact rows, `us.jsonl` of 2,660 |  1,583 | 1,597 |

FR reads zero changes. The rows that move toward the truth are bare and postcode-led streets whose
abbreviated type the check now reads: `Cedar St, WY` moves from locality `Cedar` to street `Cedar` with
suffix `St`, `TYLER ST, VT 05454` likewise, and `58482 Mills Ln, ND` splits `Mills Ln` into the name and
the suffix. The five rows that move away share one shape, a postcode, a street and a bare state name:
`05448 New St, Vermont`, `05478 Point Rd, Vermont`, `82801 Cresent Pl, Wyoming`, `05851 Lily Pond Rd,
Vermont` and `82637 N Seventh St, Wyoming`. On each the street reads as before and the state name moves
from `region` to `locality`. The street-morphology prior now fires on the first segment, and the
decoder's path through the second segment lands on the other of two near-equal admin labels.

## The board and the battery

The first board run graded the two caches under the branch's source (run
`ae55490b-5c76-41b8-a9dd-314320367326`): 10 of 1,277 rows differed, 2 improved and 1 regressed. The
regressed row, `Mischicks Day Spa - St Andrews Lakes - Rochester, Kent, Quarry Grv, Halling, Rochester
ME2 1FW`, kept its coordinate 22 m from the truth on both arms and lost `, Kent` from the venue the row
expects, the establishment's Maps title. With `st` a street type, the `St` of `St Andrews Lakes` no
longer took the first-word bias the #2575 guard reserves for a street type that opens its segment. The
guard now also reads a street type after a dash as opening a decoration, so a Saint name inside a
decorated venue keeps its bias, and `6th St SW` keeps its street reading because no dash precedes
its `St`.

The second board run graded main with the old artifact against the branch with the new one, through
two worktree arms (run `308c2082-ba6a-4b4f-aa5b-0b797baf55d1`): 0 of 1,277 rows differed at any
threshold, 459 of 756 rows within 1 km on both arms, and one tier change, `A Bar with Shapes for a
Name, 232 Kingsland Rd, Whitmore Estate, London E2 8AX, United Kingdom`, from the venue tier to the
address point, on a row with no truth coordinate. FR, GB and DE rows are unchanged.

The five golden rows that move away read the same with the street-morphology prior off and on (run
`3d4b9f88-9c6d-4e22-ad1c-1692bc660979`), so the state name's move from `region` to `locality` comes
from the street-context check, the other reader of the matcher, on the segment the new affix closes.
`58482 Mills Ln, ND` and `05821 SHIELDS LN, VT` differ between those arms, so their suffix splits are
the prior's.

The `v9.0.0-base` battery reads `PASS` on all 18 floors on both caches. Three floors move from the old
artifact to the new: `us.street` from 77.6 to 78.5, `us.micro` from 87.1 to 87.3 and `us.region` from
89.7 to 89.6. The other 15 floors read the same to the tenth.

## Decision

The rebuilt artifact ships, with the decoration reading in the venue-head guard. On the board it
changes no row, on the golden dev split it moves 20 US rows toward the truth and 5 away with 15 more
exact rows, and on the battery it raises `us.street` by 0.9 points. The five rows that move away share
the shape `postcode street, state name`, and the street-context check is their next reader to bound.
The artifact is a release-copied file in each weights package that declares it, so the published
packages pick it up at the next `copy-weights` of a release, and the data root holds it now.
