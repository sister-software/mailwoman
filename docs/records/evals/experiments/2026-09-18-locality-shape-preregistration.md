# v5.9.0 — the US admin tail redrawn over locality name shape

Pre-registered 2026-09-18, before the run reported. Config:
`corpus-python/src/mailwoman_train/configs/v5.9.0-locality-shape-60k.yaml`. Corpus
`v0.32.0-locality-shape`. Issue
[#2303](https://github.com/sister-software/mailwoman/issues/2303), and the arc
[#2311](https://github.com/sister-software/mailwoman/issues/2311) left open at the end of
[the v5.8.0 record](./2026-09-18-gazetteer-choreography-off.md).

Every number below was measured before any result was read. Bar 5 and the donor-code swap it rests
on were added after the run launched, which is stated where they appear. The result section is empty
on purpose.

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
`Forrest City` is two words and passes at 0.10. Neither does the suffix word, which `Sparta`,
`Oxford` and `Saint Louis` do not carry. What the table establishes is the competing label: the
decode is choosing `B-street` confidently rather than failing to choose. The next section separates
the two candidate causes it cannot.

### What the frame does, and what the name and the region do inside it

[#2311](https://github.com/sister-software/mailwoman/issues/2311)'s removal arm measured this, and
this record defers to it: dropping the postcode takes all 51 regions to 100.0%, spread 0.0 points,
with the region code unchanged. Missouri goes 0.0% → 100.0% and Arkansas 5.0% → 100.0%. The postcode flips the kind
verdict from `locality_only` to `structured_address`, and under `structured_address` the decode
expects a street. There is no region effect independent of that frame.

Everything below is a reading of the coded-plus-postcode frame — `«locality», «CODE» «postcode»`,
which is the surface this arm's corpus teaches and the one a user types.

The twelve-address table above cannot separate name from region: every failure in it is a name in a
low-scoring state and every pass is a name in a high-scoring one. Holding the name and the postcode
fixed and swapping only the region code shows the code modulating the label inside the frame, on all
six names:

| name          | TN          | AR          | MO          | VT            | ME            | MA            | TX            |
| ------------- | ----------- | ----------- | ----------- | ------------- | ------------- | ------------- | ------------- |
| `Sparta`      | street 0.88 | street 0.90 | street 0.90 | locality 0.43 | locality 0.36 | locality 0.43 | street 0.80   |
| `Oxford`      | street 0.73 | street 0.78 | street 0.79 | locality 0.72 | locality 0.67 | locality 0.67 | locality 0.27 |
| `Midway`      | street 0.88 | street 0.88 | street 0.90 | locality 0.75 | locality 0.69 | locality 0.76 | locality 0.16 |
| `Richland`    | street 0.87 | street 0.88 | street 0.89 | locality 0.75 | locality 0.67 | locality 0.73 | street 0.75   |
| `Saint Louis` | street 0.91 | street 0.90 | street 0.92 | locality 0.56 | locality 0.52 | locality 0.49 | street 0.90   |
| `Little Rock` | street 0.93 | street 0.92 | street 0.93 | locality 0.67 | locality 0.48 | locality 0.43 | street 0.89   |

`Sparta` reads as a street before `TN` and as a locality before `VT`, so the name alone does not
decide it inside the frame. A swap ranks the values a component takes and cannot show that the
component's presence is what accounts for the effect, which is why the removal arm is the one that
settles the attribution and this table is not. The per-region rate on this panel carries a
96.6-point spread, from MO 1/29 (3.4%) to MA 21/21 and KS 24/24 (100.0%) over the 23 states holding
20 or more rows — a reading of the frame rather than a property of the regions.

Name shape also moves inside the frame, measured on #2311's 240-place arms with the region held at
`IL`: single word 46.3% at −1.686 logits, multi-word 75.0% at −0.935, suffix tail 40.0% at −2.357.
Remove the postcode and all three read 100.0% at margins near zero. The suffix-tail bucket being the
worst of the three inside the frame is what this arm's added exposure targets.

The reading that is ruled out is corpus coverage: `synth-trailing-region-us` gives TN 347 rows,
MO 347 and AR 347 of 16,000, the same allocation Illinois gets, because `applyCountryBudget` already
round-robins over `(cc, region)`. Eleven per-region corpus statistics on #2311 predict none of the
spread either, the strongest at r = +0.304.

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
`train.trackio_run_name`, and `state-ia-builders: 0.0` / `usgov-imls-pls: 0.0`, which v5.8.0
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

## The five bars

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
| 5   | shape panel, bare arm, MO                 | 1/29 (3.4%)     | must rise    |
| 5   | same panel, AR                            | 1/23 (4.3%)     | must rise    |
| 5   | same panel, TX                            | 11/53 (20.8%)   | must rise    |
| 5   | same panel, MA and KS                     | 21/21 and 24/24 | may not fall |

Bar 2 is what separates a shape result from a row-count result. The corpus change adds 1,922
suffix-word rows and nothing for the other two buckets, so if all three rise by as much, the arm
measured the extra rows rather than their shape and the stratification carries no separate result.

Bar 4 names the two readings v5.8.0 failed at: US postcode F1 95.6% → 95.2%, and 10 regressions
across FR, GB and DE.

Bar 5 was added after the run launched and before any result was read.
[#2311](https://github.com/sister-software/mailwoman/issues/2311) requires a corpus arm on this
surface to state the per-region effect before the run and to grade per region rather than on a
pooled rate; bars 1 through 4 are all per-shape or pooled, so without bar 5 this arm could pass every
one of them while the three states reading under 21% stayed there. These are per-region readings of
the coded-plus-postcode frame rather than region properties — that frame is what a user types, so a
state stuck at 3.4% inside it is a user-visible outcome whatever its cause. A pooled rise with MO, AR
and TX flat is what bar 5 exists to make visible.

The shape panel carries no streets, so its `street_only` arm reads 0/0 and the reverse risk is read
on the 603-city panel alone.

## Result

v5.9.0 does not replace the shipped model. Bars 1, 2 and 3 pass. Bar 5 fails on Massachusetts and
Kansas. Bar 5 is a stated requirement rather than a watch, so the arm fails whatever bar 4 reads.
`release.config.json` still names `models/quantized/model-v440-suffix-boundary-v2-step-060000-int8.onnx`.

The run finished 60,000 steps from scratch on an A100-40GB. Final training validation reads
`val_loss=0.7255`, `macro_f1=0.9104` at n=4,096. Those are validation-set readings of the training
objective and decide none of the five bars.

### Receipts

Every reading below is read back from a receipt under
`$MAILWOMAN_DATA_ROOT/eval/receipts/2026-09-19-v590/`. Each receipt carries the commit it ran at, the
count of dirty tracked files at that commit, the argument vector, the panel's sha256, and the md5 of
the `model.onnx` the resolver opened for that run. The md5 is what distinguishes the arms: a staged
candidate's `model-card.json` is a symlink into the shared data root, so both arms read card 9.1.0.

| receipt                                        | model md5                          | panel                       | panel sha256 |
| ---------------------------------------------- | ---------------------------------- | --------------------------- | ------------ |
| `v570-us-shape-stratified.json`                | `e72b0cbb38754c5b07116870aeee04a4` | `us-shape-stratified.jsonl` | `af671e35…`  |
| `v590-us-shape-stratified.json`                | `8287d3790adf4a07824fcb3ac5bdbe10` | `us-shape-stratified.jsonl` | `af671e35…`  |
| `v570-us.json`                                 | `e72b0cbb38754c5b07116870aeee04a4` | `us.jsonl`                  | `45a509a1…`  |
| `v590-us.json`                                 | `8287d3790adf4a07824fcb3ac5bdbe10` | `us.jsonl`                  | `45a509a1…`  |
| `paired-us-shape-stratified-v570-vs-v590.json` | both, named inside                 | derived                     | —            |

All four ran at commit `60ad48217` with zero dirty tracked files, through
`locality-region-postcode-arms.run.ts`. The `us.jsonl` panel had no recorded hash before this run;
it is `45a509a1908466a454e6a549170f782803a23d8e950c27732da1a4eb2de16cb6`.

Both arms were staged with the same nine weights packages — the seven the board routes, plus the
published but unrouted `fr-fr` and `en-au`. The two cache roots differ in the base `model.onnx`
bytes and in nothing besides. The earlier v5.7.0 and v5.9.0 caches carried seven packages and the
v5.8.0 grading carried eight, so an FR reading taken across those three caches compares three
different stages.

### The five bars

| bar | measure                                   |          v5.7.0 |          v5.9.0 | requirement  | result    |
| --- | ----------------------------------------- | --------------: | --------------: | ------------ | --------- |
| 1   | shape panel, bare arm, suffix-word bucket | 123/379 (32.5%) | 288/379 (76.0%) | must rise    | pass      |
| 2   | same panel, other multi-word              | 189/358 (52.8%) | 307/358 (85.8%) | may not fall | pass      |
| 2   | same panel, single word                   | 321/395 (81.3%) | 328/395 (83.0%) | may not fall | pass      |
| 3   | `us.jsonl` 603-city panel, bare arm       | 555/603 (92.0%) | 591/603 (98.0%) | may not fall | pass      |
| 3   | same panel, `street_only` reverse arm     |         594/603 |         597/603 | may not fall | pass      |
| 4   | US `postcode` per-tag F1, n=2,660         |           95.6% |       see bar 4 | must hold    | see below |
| 4   | D-rule regressions on FR, GB, DE          |               — |       see bar 4 | none         | see below |
| 5   | shape panel, bare arm, MO                 |     1/29 (3.4%) |  29/29 (100.0%) | must rise    | pass      |
| 5   | same panel, AR                            |     1/23 (4.3%) |   21/23 (91.3%) | must rise    | pass      |
| 5   | same panel, TX                            |   11/53 (20.8%) |   16/53 (30.2%) | must rise    | pass      |
| 5   | same panel, MA                            |  21/21 (100.0%) |   19/21 (90.5%) | may not fall | **fail**  |
| 5   | same panel, KS                            |  24/24 (100.0%) |   13/24 (54.2%) | may not fall | **fail**  |

Bar 2 separates a shape result from a row-count result, and it separates them. The corpus change
added 1,922 suffix-word rows and nothing to the other two buckets. Suffix-word rose 43.5pp, other
multi-word rose 33.0pp and single word rose 1.7pp, so the buckets did not move together and the
stratification carries a result of its own.

### What the pooled rate hides

Pooled shape-panel bare matching rose from 633/1,132 (55.9%) to 923/1,132 (81.5%), a gain of
25.6pp. Of the 1,132 paired rows, 354 were fixed and 64 regressed, for a net of 290.

Eighteen states carry at least one regression. The eight that lost ground overall:

| state | panel rows | v5.7.0 | v5.9.0 |   change | fixed | regressed |
| ----- | ---------: | -----: | -----: | -------: | ----: | --------: |
| WV    |         25 |  60.0% |   0.0% | −60.0 pp |     0 |        15 |
| SC    |         17 |  58.8% |   0.0% | −58.8 pp |     0 |        10 |
| KS    |         24 | 100.0% |  54.2% | −45.8 pp |     0 |        11 |
| MN    |         27 |  55.6% |  25.9% | −29.6 pp |     0 |         8 |
| VT    |          8 | 100.0% |  75.0% | −25.0 pp |     0 |         2 |
| ME    |         13 | 100.0% |  76.9% | −23.1 pp |     0 |         3 |
| MA    |         21 | 100.0% |  90.5% |  −9.5 pp |     0 |         2 |
| CT    |         11 |  63.6% |  54.5% |  −9.1 pp |     1 |         2 |

South Carolina loses every one of its 17 rows and sits outside bar 5, which named the five states at
the ends of v5.7.0's pre-result spread. Bar 5 is therefore a sample of the region-level requirement
rather than the whole of it, and this table is the reason to write the next one over every state
carrying enough rows to read.

The complete fixed and regressed lists, with each row's expected locality and what each arm answered,
are in `paired-us-shape-stratified-v570-vs-v590.json`.

### Reproducing it

```sh
node packages/mailwoman/lib/dev-tools/us/locality-region-postcode-arms.run.ts \
  --eval $MAILWOMAN_DATA_ROOT/eval/coord/us-shape-stratified.jsonl \
  --weights-cache $MAILWOMAN_DATA_ROOT/candidates/v590-cache-published \
  --out-json <receipt>
```

Stage a matched cache with
`stage-candidate-cache.run.ts --model <int8.onnx> --out <root> --locales en-us,en-gb,en-nz,de-de,en-in,es-es,it-it,fr-fr,en-au`.
Read the receipt's `provenance` block before comparing two of them: two receipts whose
`weightsModelMD5` agree are the same arm under two names.
