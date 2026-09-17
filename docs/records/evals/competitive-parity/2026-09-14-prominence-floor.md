# A prominence floor cannot provide abstention (2026-09-14)

`ResolveOpts.minWinningScore` rejects a candidate whose score falls below a floor. The backend's score is a
log-population rank, so a floor of F rejects any place under 10^F people. The registered claim was:

> A `minWinningScore` floor reduces the withheld-gold false-selection rate against the default arm in EVERY
> population band, without costing more than 5 points of selection accuracy in any band.

**The claim does not hold, at any of the four registered floors.** Every floor provides refusal by discarding
correct answers, and the smaller the place the more it discards: at floor 4 the selection accuracy for
villages under 1,000 people falls from 71.0% to 21.0%.

## Why this panel exists

The [same-data benchmark](./2026-09-13-same-data.md) measured this same option and produced the opposite
reading — 75 of 100 false selections down to 26, for 1.5 points of accuracy. Ten of that 75 name the
withheld settlement under another WOF id and are not false
([the correction](./2026-09-13-same-data.md#correction-what-the-withheld-gold-rate-counts)), which
changes the rate and not the comparison drawn here. That panel's gold comes from
GeoNames `cities15000.txt` under a 50,000 rule, so all 453 of its gold entities carry population above 15,151.
A floor of 4.0 is a population floor of 10,000. It admitted every correct answer that panel contained, by
construction rather than by merit, and rejected only wrong ones. A panel whose gold all clears a floor cannot
measure that floor.

This panel draws gold across five population bands, from 1 to millions, so the floor meets small places too.
Same option, same code, opposite verdict — the difference is the panel.

## The registered rule, per arm

| arm     | smallest false-selection drop, any band | largest accuracy cost, any band | rule met |
| ------- | --------------------------------------- | ------------------------------- | -------- |
| floor_1 | 11.0 points                             | 16.0 points                     | no       |
| floor_2 | 14.0 points                             | 16.0 points                     | no       |
| floor_3 | 20.0 points                             | 49.0 points                     | no       |
| floor_4 | 23.0 points                             | 55.0 points                     | no       |

Every floor clears the 10-point refusal requirement in every band. Every floor fails the 5-point accuracy
condition, by between 3 and 11 times the allowance.

## Per band and arm

Generated into [`prominence-floor-report.md`](/benchmarks/prominence-floor-report.md) and committed verbatim.
All 1,000 rows survived every arm without a replay miss, so no denominator moves between arms.

| band          | arm     | selection accuracy | wrong-area rate | false-selection rate |
| ------------- | ------- | ------------------ | --------------- | -------------------- |
| pop_1_999     | default | 71.0% (71/100)     | 9.0% (8/89)     | 47.0% (47/100)       |
| pop_1_999     | floor_1 | 70.0% (70/100)     | 7.0% (6/86)     | 36.0% (36/100)       |
| pop_1_999     | floor_2 | 69.0% (69/100)     | 6.0% (5/83)     | 33.0% (33/100)       |
| pop_1_999     | floor_3 | 22.0% (22/100)     | 18.5% (5/27)    | 7.0% (7/100)         |
| pop_1_999     | floor_4 | 21.0% (21/100)     | 12.5% (3/24)    | 6.0% (6/100)         |
| pop_1k_4999   | default | 70.0% (70/100)     | 8.1% (7/86)     | 52.0% (52/100)       |
| pop_1k_4999   | floor_1 | 62.0% (62/100)     | 9.1% (7/77)     | 33.0% (33/100)       |
| pop_1k_4999   | floor_2 | 62.0% (62/100)     | 9.1% (7/77)     | 33.0% (33/100)       |
| pop_1k_4999   | floor_3 | 61.0% (61/100)     | 9.2% (7/76)     | 32.0% (32/100)       |
| pop_1k_4999   | floor_4 | 15.0% (15/100)     | 20.0% (4/20)    | 18.0% (18/100)       |
| pop_5k_14999  | default | 81.0% (81/100)     | 4.3% (4/94)     | 54.0% (54/100)       |
| pop_5k_14999  | floor_1 | 65.0% (65/100)     | 3.9% (3/76)     | 19.0% (19/100)       |
| pop_5k_14999  | floor_2 | 65.0% (65/100)     | 3.9% (3/76)     | 19.0% (19/100)       |
| pop_5k_14999  | floor_3 | 65.0% (65/100)     | 2.7% (2/75)     | 18.0% (18/100)       |
| pop_5k_14999  | floor_4 | 34.0% (34/100)     | 2.4% (1/42)     | 16.0% (16/100)       |
| pop_15k_49999 | default | 65.0% (65/100)     | 18.9% (17/90)   | 62.0% (62/100)       |
| pop_15k_49999 | floor_1 | 52.0% (52/100)     | 19.4% (14/72)   | 38.0% (38/100)       |
| pop_15k_49999 | floor_2 | 52.0% (52/100)     | 19.4% (14/72)   | 38.0% (38/100)       |
| pop_15k_49999 | floor_3 | 52.0% (52/100)     | 18.3% (13/71)   | 37.0% (37/100)       |
| pop_15k_49999 | floor_4 | 50.0% (50/100)     | 17.6% (12/68)   | 32.0% (32/100)       |
| pop_50k_up    | default | 19.0% (19/100)     | 70.1% (61/87)   | 72.0% (72/100)       |
| pop_50k_up    | floor_1 | 18.0% (18/100)     | 66.2% (45/68)   | 49.0% (49/100)       |
| pop_50k_up    | floor_2 | 18.0% (18/100)     | 65.7% (44/67)   | 49.0% (49/100)       |
| pop_50k_up    | floor_3 | 18.0% (18/100)     | 65.2% (43/66)   | 49.0% (49/100)       |
| pop_50k_up    | floor_4 | 18.0% (18/100)     | 64.1% (41/64)   | 49.0% (49/100)       |

Read the accuracy column down each band. The floor's cost tracks the band: at floor 4 it is 50 points for
villages under 1,000, 55 points for 1,000–4,999, 47 points for 5,000–14,999, 15 points for 15,000–49,999, and
1 point above 50,000. That gradient is the mechanism stated plainly — a floor at population 10,000 rejects the
correct answer for every place smaller than 10,000, and the correct answer is most of what a small-place query
has.

A floor is not an abstention rule. It is a size filter that abstains as a side effect, and it cannot tell a
place that should not be selected from a place that is merely small.

## A defect in this panel, found because a result was surprising

The largest band reads worst at the default arm — 19.0% accuracy and 70.1% wrong-area, against 65% to 81% in
every other band. That is backwards, and checking it found the reason.

The eligibility rule requires a name borne exactly once across the four registered countries. A large city
usually shares its name with something — its own arrondissement, district or a namesake abroad — so it is
excluded. An administrative division carries a long unique name and survives. Counted by a leading
administrative noun in the four registers' languages:

| band          | rows | administrative-division names |
| ------------- | ---: | ----------------------------: |
| pop_1_999     |  200 |                             0 |
| pop_1k_4999   |  200 |                             0 |
| pop_5k_14999  |  200 |                             0 |
| pop_15k_49999 |  200 |                            27 |
| pop_50k_up    |  200 |                           142 |

So `pop_50k_up` is 71% rows like `Arrondissement de Vannes` (295,698), `Kreis Lippe` (347,149) and
`Vale of White Horse District` (128,738). Its numbers describe administrative-division resolution, not city
resolution, and should not be read as the latter.

**The verdict does not rest on those bands.** Each arm's disqualifying accuracy cost falls on a band with zero
administrative names: floor_1 and floor_2 lose 16.0 points at `pop_5k_14999`, floor_3 loses 49.0 at
`pop_1_999`, floor_4 loses 55.0 at `pop_1k_4999`. Every floor fails on clean evidence.

The panel is not being rebuilt to remove the contamination. The definition was frozen before any of this ran,
and redrawing eligibility after seeing a result is the rule moving to fit the answer. A successor definition
with a placetype condition is the right vehicle, and its numbers would be a separate record.

## What this supports

Supported: `minWinningScore` cannot serve as an abstention default at any value. The four floors span the
populated range of the backend's score, every one clears the refusal bar, and every one fails the accuracy
bar on evidence untouched by the panel's defect.

Supported: the same-data benchmark's reading of this option was an artifact of its gold source. Same option,
same code, 1.5 points of accuracy there against 55 points here — and the record that reported the favourable
number already said its panel could not measure a floor. It could not.

Refused: any claim about a fit-based abstention signal, which this benchmark does not test. The
[abstention-threshold record](./2026-09-13-abstention-threshold.md) showed a margin threshold beats the
deterministic baseline on both axes but floors at 28% invented selections, because the margin is a within-pool
quantity that cannot see whether the pool holds the answer. Nothing here changes that, and a signal reading
the winner's FIT to the query remains the open question.

Scope: four countries, gold with a recorded population above zero, admin candidate selection only.

## Artifacts

| artifact                                                   | sha256                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/static/benchmarks/prominence-floor-candidates.jsonl` | `626e4f6f4192f1c04e40eb681bc44ac81b9f64ca2beae2fba8ea9f133a047fb0` |
| frozen ruler `prominence-floor-v1` 1.0.0                   | `0750cdbafeda0b6a4e4891114ca3ce0fc1493af4089204098464decfb208d3cf` |

1,000 panel rows from 606,894 register rows, of which 147,103 carried a coherent gold identity set. Zero
recording errors; equal evidence confirmed over all 1,000 rows; every arm scored every row without a replay
miss.

## Reproduction

```bash
node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts panel
node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts record
node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts run
node packages/mailwoman/lib/dev-tools/prominence-floor.run.ts score
```

`panel` and `record` need the GeoNames per-country dumps and the gazetteers; `run` and `score` read only the
committed fixture.
