# Abstention threshold for admin selection (2026-09-13)

The [same-data controlled benchmark](./2026-09-13-same-data.md) refused its registered claim on one
condition: in the withheld-gold stratum, where no correct candidate is in the pool by construction,
Mailwoman answered on 75 of 100 rows against the baseline's 57. This record measures what an
abstention rule could do about that, on the same 453 frozen rows.

**Exploratory, and outside that pre-registration.** Every threshold here was read off results that
were already visible, which is the one thing the registered rule forbids. Nothing below re-decides the
frozen verdict, and no threshold earns a claim until it is registered ahead of a panel it has not
seen.

Four findings, in the order they constrain each other:

1. A threshold on the confidence the resolver already records beats the baseline on **both** axes at
   once — at four of the fifteen tested values it would also have satisfied the full registered rule.
2. That same signal is blind to the case it most needs to catch. 28 of the 75 false selections carry
   the maximum confidence, so no threshold can reach a false-selection rate below 28%.
3. `ResolveOpts.minWinningScore`, the shipped knob nearest to this, moves the false-selection rate
   from 75% to 74% across the populated range of its scale — one row.
4. It is not inert because it fails to refuse. It refuses, and `spanRescore` answers the refusal:
   `applySpanRescore` declines only when the tree already holds a resolved place, so a refusal leaves
   exactly the state that invites it. With both off the rate is 8%. **A deliberate refusal and a
   failed parse are the same state, and the recovery pass answers both.** That is the finding worth
   acting on; the 8% itself is confounded by how this panel was built.

## What is being thresholded

Every arm reports confidence as the winner's margin over the runner-up within the set that arm
considered, normalized into [0, 1], and **1 when there was no runner-up**. The sweep re-grades the
committed results: a selection whose confidence falls below the threshold is re-read as an abstention.

No resolver is re-run, so the walk is held fixed. A resolver that actually refused a node could ask
different questions afterwards, through `parentFallback` and `hierarchyCompletion`, and reach a
different final selection. Everything in the next two sections is therefore an upper bound on what a
threshold over this signal can buy at the final selection, not a prediction of shipped behaviour. The
knob section below is the opposite: a real replay, and it shows what that caveat costs.

## The trade curve

Generated into [`same-data-threshold.md`](/benchmarks/same-data-threshold.md) and committed verbatim.

| threshold | withheld | selections | selection accuracy | wrong-area rate | false-selection rate |
| --------- | -------- | ---------- | ------------------ | --------------- | -------------------- |
| 0.00      | 0        | 383        | 69.7% (246/353)    | 19.2% (59/308)  | 75.0% (75/100)       |
| 0.01      | 107      | 276        | 59.5% (210/353)    | 9.2% (21/228)   | 48.0% (48/100)       |
| 0.05      | 130      | 253        | 55.2% (195/353)    | 6.3% (13/206)   | 47.0% (47/100)       |
| 0.10      | 143      | 240        | 53.8% (190/353)    | 5.1% (10/198)   | 42.0% (42/100)       |
| 0.15      | 149      | 234        | 53.5% (189/353)    | 5.1% (10/197)   | 37.0% (37/100)       |
| 0.20      | 160      | 223        | 51.3% (181/353)    | 5.3% (10/189)   | 34.0% (34/100)       |
| 0.30      | 181      | 202        | 46.2% (163/353)    | 4.1% (7/169)    | 33.0% (33/100)       |
| 0.40      | 208      | 175        | 39.9% (141/353)    | 4.1% (6/146)    | 29.0% (29/100)       |
| 0.50      | 215      | 168        | 38.2% (135/353)    | 4.3% (6/140)    | 28.0% (28/100)       |
| 1.00      | 221      | 162        | 36.5% (129/353)    | 4.5% (6/134)    | 28.0% (28/100)       |

The baseline reads 45.3% accuracy and 57.0% false selection. Six of the fifteen thresholds beat it on
both axes at once, from 0.01 to 0.30. Both axes together, because either alone is trivially winnable:
threshold 0 maximizes accuracy and threshold 1 minimizes false selection, and each is the other's
worst case.

The wrong-area rate falls with them, from 19.2% to 9.2% at the first step. That is a second and
independent sign that the margin carries information about correctness — nothing in the sweep grades
distance, so the wrong-area column moving is the withheld rows having been disproportionately wrong.

### The registered rule, re-read at each dominating threshold

Run through the same `comparePaired` and `evaluateVerdict` the frozen decision used, so a difference
is the threshold and nothing else.

| threshold | pooled margin | exact McNemar p | per-stratum regressions | rule would read |
| --------- | ------------- | --------------- | ----------------------- | --------------- |
| 0.01      | 14.2 points   | 6.910e-6        | none                    | yes             |
| 0.05      | 9.9 points    | 2.829e-3        | none                    | yes             |
| 0.10      | 8.5 points    | 1.069e-2        | none                    | yes             |
| 0.15      | 8.2 points    | 1.412e-2        | none                    | yes             |
| 0.20      | 5.9 points    | 7.553e-2        | none                    | no              |
| 0.30      | 0.8 points    | 8.570e-1        | none                    | no              |

### What the first step actually moves

Threshold 0.01 withholds only the selections whose margin is effectively zero. It withholds 107 of
Mailwoman's 383 selections:

| what was withheld                       | rows |
| --------------------------------------- | ---: |
| gold-present, the selection was correct |   36 |
| gold-present, the selection was wrong   |   44 |
| withheld-gold, a false selection        |   27 |
| (of the gold-present rows, wrong-area)  |   38 |

71 wrong answers removed for 36 correct ones — and the 36 are real losses, each an address the
resolver had right:

| row             | query               | gold                   | confidence |
| --------------- | ------------------- | ---------------------- | ---------- |
| unambiguous-021 | `Paris 10 Entrepôt` | Paris 10 Entrepôt (FR) | 0.0016     |
| unambiguous-025 | `La Crosse`         | La Crosse (US)         | 0.0000     |
| unambiguous-052 | `Clamart`           | Clamart (FR)           | 0.0028     |
| unambiguous-053 | `San Severo`        | San Severo (IT)        | 0.0053     |
| unambiguous-072 | `Orihuela`          | Orihuela (ES)          | 0.0046     |

Against them, the false selections it removes:

| row             | query       | picked        | distance from gold |
| --------------- | ----------- | ------------- | ------------------ |
| gold_absent-002 | `Huangzhou` | 1309875123    | 697 km             |
| gold_absent-005 | `Neili`     | 1243172693    | 25 km              |
| gold_absent-007 | `Ghāziābād` | 8133386609648 | 492 km             |
| gold_absent-019 | `Changchun` | 1360059747    | 1027 km            |
| gold_absent-020 | `Wenzhou`   | 1193128627    | 258 km             |

## The floor the margin cannot cross

28 of the 75 false selections carry confidence 1, because the lookup that produced them considered a
single candidate. No threshold at or below 1 can withhold those, which is why the curve flattens at
28% and stays there.

The reason is structural rather than a tuning problem. The margin is a **within-pool** quantity: it
measures the winner's lead over its rivals, so it is blind to whether the pool contains the answer at
all. The same value means opposite things on either side of the panel:

| rows          | selections at margin 1 | correct           |
| ------------- | ---------------------: | ----------------- |
| gold present  |                    134 | 129 (96.3%)       |
| withheld gold |                     28 | 0 by construction |

A lone candidate is usually the right one when the gold is in the pool, and necessarily the wrong one
when it is not. Abstaining on absent gold needs a signal about the winner's **fit to the query** —
how much of the input it explains, whether its hierarchy is consistent with the rest — not its lead
over rivals it never had.

The mechanisms behind those 28 rows:

| mechanism                                                      | rows of 28 |
| -------------------------------------------------------------- | ---------: |
| `picked:ranked bare_race`                                      |         23 |
| `picked:span_rescore span_rescore rescore_postcode_unverified` |          4 |
| `picked:bare_region bare_race bare_region_repick`              |          1 |

`Langfang`, `Tirur`, `Matsusaka`, `Batāla` and `Troyes` are five of the 23: a bare toponym whose real
referent was withheld, answered at full confidence from a lookup that considered one candidate.

**`bare_race` needs its denominator before it reads as a cause.** The check fires for a lone
locality-tagged node, and this stratum is built from bare toponyms, so it fires on most of the
stratum whatever the outcome:

| withheld-gold rows | carrying `bare_race` | selected   |
| ------------------ | -------------------: | ---------- |
| all 100            |                   69 | 75         |
| `bare_race`        |                   69 | 57 (82.6%) |
| no `bare_race`     |                   31 | 18 (58.1%) |

On the gold-present rows it fires on 73 of 353. So it marks a query SHAPE, not a failure: bare-toponym
rows do select more often than the rest of the stratum, 82.6% against 58.1%, but two thirds of the
stratum carries the check and a quarter of those rows still abstained. The enrichment is worth a
separate measurement; it is not on its own evidence that the race manufactures these selections.

What the 28 rows do share is the pool the deciding lookup saw: 17 of them had a single candidate in
the row's whole pool, and the rest reached a lookup that considered one even though the row's union
across lookups held three to five.

## The shipped knob is inert, and the reason is a second pass

Generated into [`same-data-knob.md`](/benchmarks/same-data-knob.md). Unlike the curve above this is a
real replay of the resolver at each option set, not a re-grade. Every rate is measured over the 341 of
453 rows that every arm scored without a replay miss, so the columns are comparable to each other;
all 100 withheld-gold rows survive every arm, so the false-selection column is complete.

| arm                                 | replay misses | selection accuracy | wrong-area rate | false-selection rate |
| ----------------------------------- | ------------- | ------------------ | --------------- | -------------------- |
| default                             | 0             | 67.6% (163/241)    | 15.3% (30/196)  | 75.0% (75/100)       |
| minWinningScore 1                   | 31            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 2                   | 32            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 3                   | 34            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 4                   | 35            | 67.6% (163/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| minWinningScore 5                   | 112           | 68.0% (164/241)    | 12.8% (25/196)  | 74.0% (74/100)       |
| spanRescore off                     | 0             | 51.5% (124/241)    | 13.1% (19/145)  | 57.0% (57/100)       |
| minWinningScore 4 + spanRescore off | 25            | 51.0% (123/241)    | 5.8% (8/138)    | 8.0% (8/100)         |

A floor on its own moves the false-selection rate by one row across the whole populated range of the
scale, and does not move selection accuracy at all. Turning off `spanRescore` alone moves it to 57.
The two together move it to **8**, which is far more than either.

The floor is refusing. What it is not doing is producing an abstention, because
`applySpanRescore` begins `if (hasResolvedPlace(roots)) return` (`packages/resolver/lib/resolve/passes.ts`)
— it declines only when the tree already holds a resolved place. A refusal leaves a tree with no
resolved place, which is precisely the recovery pass's trigger condition. The mechanism counts show
the handover directly: at floor 4 the rows decided by `picked:ranked` fall from 56 to 8 while
`picked:span_rescore` rises from 18 to 66.

Span rescore was built to recover a locality the parser fragmented, and its own header calls the
early return the "#685 brake — never second-guess a working coordinate". The brake reads a resolved
place, so it cannot tell a deliberate refusal from a parse that failed. **A refusal and a failure are
the same state, and the recovery pass answers both.**

### The 8% is this panel's construction, and cannot be read as a setting

A floor of 4.0 on a log-population score is a population floor of 10,000. **Zero of the 453 gold
entities fall below it**, and it is not close:

| stratum                | rows | smallest gold | log10 |
| ---------------------- | ---: | ------------: | ----: |
| unambiguous            |  100 |        50,923 |  4.71 |
| homograph_qualified    |   53 |        15,151 |  4.18 |
| reordered              |  100 |        50,017 |  4.70 |
| contradictory_postcode |  100 |        50,171 |  4.70 |
| gold_absent            |  100 |        50,467 |  4.70 |

The gold comes from GeoNames `cities15000.txt` and the panel's own rule sets a 50,000 floor on the
three strata that share its pool. So a floor at 4.0 admits every correct answer this panel contains
and rejects the smaller namesakes around them — it is calibrated to the panel by accident of how the
panel was built, and a user asking for a village of 800 people meets the same floor.

The magnitude therefore says nothing about what a floor should be, and this panel cannot be used to
choose one. What survives the confound is the mechanism: a refusal in one pass is answered by
another, and no choice of floor can show through while that holds. That part is read from the code
and confirmed by the mechanism counts, neither of which depends on the panel.

## What this supports, and what comes next

Supported: the ranking already carries a signal that separates supportable selections from
unsupportable ones well enough to beat the deterministic baseline on selection accuracy and false
selection simultaneously, and the resolver does not consult it. Supported: `spanRescore` answers a
refusal `minWinningScore` made, because the state the refusal leaves is the state the recovery pass
triggers on — read from the code and confirmed by the mechanism counts, so it does not depend on this
panel. Refused: any claim that a particular threshold or floor is the right one; the floor that
produces 8% here is calibrated by accident to a panel whose gold all has population above 15,000.

Four next measurements, in order of what they would settle:

1. Give a refusal a state of its own, so `applySpanRescore`'s early return can tell it from a parse
   that resolved nothing, and re-run this table — tracked as
   [#2265](https://github.com/sister-software/mailwoman/issues/2265). Until a refusal can survive the
   walk, no abstention rule can be measured end to end: every one of them will be answered by the
   recovery pass.
2. Register a threshold and a fit-based abstention signal ahead of a fresh panel whose gold spans
   population strata rather than sitting entirely above 15,151. The margin caps at 28% false
   selection, and no panel whose every gold answer clears a floor can measure that floor.
3. Measure the bare-toponym race against a matched arm. Withheld-gold rows carrying `bare_race` select
   on 82.6% against 58.1% for the rest of the stratum, but the check also fires on 69 of the 100 rows,
   so the comparison needs rows matched on query shape before that gap means anything.
4. Re-run any candidate threshold as a real replay rather than a re-grade. The knob table shows the
   re-grade and the replay disagree about which rows are even measurable.

## Reproduction

```bash
node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts sweep
node packages/mailwoman/lib/dev-tools/same-data-benchmark.run.ts knob
```

`sweep` reads only the committed panel and results. `knob` additionally replays the committed fixture
through the resolver and needs no database. Both are deterministic; the paired bootstrap uses the
frozen benchmark's 10,000 resamples at seed 20260913.
