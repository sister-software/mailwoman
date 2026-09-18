# v5.9.0 — the US admin tail redrawn over locality name shape

Pre-registered 2026-09-18, before the run reported. Config:
`corpus-python/src/mailwoman_train/configs/v5.9.0-locality-shape-60k.yaml`. Corpus
`v0.32.0-locality-shape`. Issue
[#2303](https://github.com/sister-software/mailwoman/issues/2303), and the arc
[#2311](https://github.com/sister-software/mailwoman/issues/2311) left open at the end of
[the v5.8.0 record](./2026-09-18-gazetteer-choreography-off.md).

Every number below was measured before the run launched. The result section is empty on purpose.

## What is being tested

v5.7.0 already carries the bare `locality, REGION postcode` surface: `synth-trailing-region-us`
added 16,000 rows to `v0.31.0-region-code-and-unit`. It reads 555/603 (92.0%) on the 603-city bare
arm and 46/77 (59.7%) in that panel's suffix-word bucket. This arm asks whether the remaining
shortfall is exposure to the shape, by redrawing the same 16,000-row budget over locality name
shape and changing nothing else.

`applyCountryBudget` gains the shape in its bucket key, so the budget spends across
(cc, region, shape) rather than (cc, region):

| bucket                     |        v0.31.0 |       v0.32.0 |
| -------------------------- | -------------: | ------------: |
| ends in a USPS suffix word |  1,653 (10.3%) | 3,575 (22.4%) |
| other multi-word           |  1,924 (12.0%) | 3,871 (24.2%) |
| single word                | 12,423 (77.6%) | 8,530 (53.4%) |
| total                      |         16,000 |        15,976 |

22.4% is the ceiling this budget reaches. The US GeoNames postal export holds 40,979 rows carrying
both a place and an admin1, of which 4,189 end in a USPS suffix word;
`createKnownLocalityCheck("US")` admits 4,060 and the draw takes 3,575 of them (88.1%). An even
three-way split at 16,000 tuples would need 5,333, which the source does not hold.

Nothing else about the source moved. Component sequences hold at
`locality+region+postcode+country` 50.0%, `house_number+locality+region+postcode` 25.0%,
`locality+region+postcode` 25.0%; the region is written as a full name in 66.7% of rows and as a
code in 33.3%. The 24 missing rows are the ones the recipe's own label audit refused.

## The parse behind the failures

`Saint Louis, MO 63131` answers no locality under v5.7.0. The same locality answers correctly with
one more component in either direction, so the place is reachable and the surface is what fails:

| input                                | geocoded locality |
| ------------------------------------ | ----------------- |
| `Saint Louis, MO 63131`              | none              |
| `Saint Louis, MO 63131, USA`         | `Saint Louis`     |
| `123 Main St, Saint Louis, MO 63131` | `Saint Louis`     |

Read through `diagnoseParse`, the leading token of every failure carries `B-street`:

| input                    | leading token | label        | confidence | parsed locality |
| ------------------------ | ------------- | ------------ | ---------: | --------------- |
| `Saint Louis, MO 63131`  | `▁Saint`      | `B-street`   |       0.92 | none            |
| `Little Rock, AR 72210`  | `▁Little`     | `B-street`   |       0.92 | none            |
| `Fort Smith, AR 72903`   | `▁Fort`       | `B-street`   |       0.91 | none            |
| `Santa Fe, TN 38482`     | `▁Santa`      | `B-street`   |       0.92 | none            |
| `Sparta, TN 38583`       | `▁Sparta`     | `B-street`   |       0.88 | none            |
| `Oxford, AR 72565`       | `▁Oxford`     | `B-street`   |       0.78 | none            |
| `Midway, AR 72651`       | `▁Midway`     | `B-street`   |       0.88 | none            |
| `Orland Park, IL 60467`  | `▁Orland`     | `B-street`   |       0.81 | none            |
| `San Rafael, CA 94901`   | `▁San`        | `B-street`   |       0.90 | none            |
| `Forrest City, AR 72335` | `▁Forrest`    | `B-locality` |       0.10 | `Forrest City`  |
| `Chicago, IL 60639`      | `▁Chicago`    | `B-locality` |       0.87 | `Chicago`       |
| `Burlington, VT 05401`   | `▁Burlington` | `B-locality` |       0.91 | `Burlington`    |

Word count does not separate the groups: `Sparta` and `Oxford` are single words and fail,
`Forrest City` is two words and passes at 0.10. Every failing name is also a common US street name.
The suffix-word bucket is a partial reading of that ambiguity — it catches `Orland Park` and misses
`Sparta` — which is why this arm is a partial treatment by construction and why bar 2 exists.

### Two readings ruled out

A per-state cross of the same probe showed TN, MO and AR at 2/67 pooled on the bare arm, including
0/19 on single-word localities against 321/395 (81.3%) single-word pooled. That is the same
name-level effect measured too narrowly rather than a regional one: `synth-trailing-region-us`
gives TN 347 rows, MO 347 and AR 347 of 16,000, the same allocation Illinois gets, because
`applyCountryBudget` already round-robins over `(cc, region)`.

The locality-surface lexicon does not separate the groups either, and its direction is inverted, so
extending it is not the action this reading calls for:

| `locality-surface-lexicon-v7.json` value |  rows | matched |  rate |
| ---------------------------------------- | ----: | ------: | ----: |
| 1 = locality                             |   604 |     271 | 44.9% |
| 3 = locality and homograph               |   285 |     175 | 61.4% |
| absent                                   |   243 |     187 | 77.0% |
| all                                      | 1,132 |     633 | 55.9% |

## The arm is v5.7.0's twin

Diffed as parsed YAML rather than as text, `v5.9.0-locality-shape-60k.yaml` differs from
`v5.7.0-region-code-and-unit-60k.yaml` in five keys: `data.corpus_dir`, `train.output_dir`,
`train.trackio_run_name`, and `state-ia-contractors: 0.0` / `usgov-imls-pls: 0.0`, which v5.8.0
added so the loader starts and which reproduce the zero exposure v5.7.0 gave both sources. Seed 42,
60,000 steps, `gazetteer_choreography: true`, from scratch with no `init_from`.

`audit_epoch_mixture` passes all 13 corpus receipts, and the mixture reproduces v5.7.0's within
sampling noise:

| receipt                              | v5.7.0 draws | v5.9.0 draws | delta |
| ------------------------------------ | -----------: | -----------: | ----: |
| us-city-state-postcode               |        2,128 |        2,127 |    −1 |
| ca-region-code-tail                  |        7,249 |        7,056 |  −193 |
| us-secondary-unit-current-generation |        8,709 |        8,739 |   +30 |
| fr-bare-street-current-generation    |       69,653 |       69,813 |  +160 |

## The four bars

Baselines measured under the v5.7.0 candidate (`candidates/v570-cache`, `model.onnx` md5
`e72b0cbb`) with `packages/mailwoman/lib/dev-tools/us/locality-region-postcode-arms.run.ts`.

Both panels are build-local. `us-shape-stratified.jsonl` rebuilds byte for byte from
`stratified-panel.run.ts --stratify shape --per-region 400`, at sha256
`af671e351d3be6faa9dabf0ec9122d0b3ecd12140d03aa1c6b2bef9248d53a60`.

| bar | measure                                   | v5.7.0          | requirement  |
| --- | ----------------------------------------- | --------------- | ------------ |
| 1   | shape panel, bare arm, suffix-word bucket | 123/379 (32.5%) | must rise    |
| 2   | same panel, other multi-word              | 189/358 (52.8%) | may not fall |
| 2   | same panel, single word                   | 321/395 (81.3%) | may not fall |
| 3   | `us.jsonl` 603-city panel, bare arm       | 555/603 (92.0%) | may not fall |
| 3   | same panel, `street_only` reverse arm     | 594/603         | may not fall |
| 4   | US `postcode` per-tag F1, n=2,660         | 95.6%           | must hold    |
| 4   | D-rule regressions on FR, GB, DE          | —               | none         |

Bar 2 is what separates a shape result from a row-count result. The corpus change adds 1,922
suffix-word rows and nothing for the other two buckets, so if all three rise by as much, the arm
measured the extra rows rather than their shape and the stratification carries no separate result.

Bar 4 names the two readings v5.8.0 failed at: US postcode F1 95.6% → 95.2%, and 10 regressions
across FR, GB and DE.

The shape panel carries no streets, so its `street_only` arm reads 0/0 and the reverse risk is read
on the 603-city panel alone.

## Result

Pending. The run is 60,000 steps from scratch on an A100-40GB.
