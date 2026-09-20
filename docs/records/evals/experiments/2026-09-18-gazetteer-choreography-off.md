# v5.8.0 — training with the near-postcode gazetteer choreography off

Closed 2026-09-18. Two of four pre-registered bars fail; the arm does not ship as the default model.
Config: `corpus-python/src/mailwoman_train/configs/v5.8.0-gazetteer-choreography-off-60k.yaml`.
Issues [#2308](https://github.com/sister-software/mailwoman/issues/2308),
[#2311](https://github.com/sister-software/mailwoman/issues/2311).

## What was tested

`gazetteer_choreography` zeroes the gazetteer clue within one piece of a postcode-anchor hit at train
time; `suppress_gazetteer_near_postcode` is its inference-time half. v5.8.0 is v5.7.0 with that one
config key flipped to `false` — 60,000 steps from scratch, seed 42, corpus
`v0.31.0-region-code-and-unit`, tokenizer `v0.9.0-multisplice`.

Both arms were graded through the same harness on caches staged with the same eight locales and 60
linked files each, differing in exactly two things:

| arm              | `model.onnx` md5                   | `requires.suppress_gazetteer_near_postcode` |
| ---------------- | ---------------------------------- | ------------------------------------------- |
| v5.8.0 candidate | `ad582b045a9dde35f3ccb140aac57403` | en-us, en-gb, fr-fr all `false`             |
| v5.7.0 control   | `e72b0cbb38754c5b07116870aeee04a4` | en-us, en-gb, fr-fr all `true`              |

## The four bars, as pre-registered

| bar | measure                                     | v5.7.0          | v5.8.0                | verdict  |
| --- | ------------------------------------------- | --------------- | --------------------- | -------- |
| 1   | 603-city panel, bare arm                    | 92.0% (555/603) | 94.7% (571/603)       | pass     |
| 1   | suffix-tail bucket                          | 46/77 (59.7%)   | 62/77 (80.5%)         | pass     |
| 1   | `street_only` reverse risk                  | 594/603         | 595/603               | pass     |
| 2   | US `postcode` per-tag F1, n=2660            | 95.6%           | 95.2%                 | **fail** |
| 3   | board net improved − regressed, 1,029 cases | —               | +2 (20 up, 18 down)   | pass     |
| 4   | D-rule regressions on FR/GB/DE              | —               | 10 (8 GB, 2 FR, 0 DE) | **fail** |

Bar 2 is quoted verbatim from the config: "Per-tag US postcode F1 may not regress against v5.7.0. A
loss here is the expected cost of the change and the number that decides whether it ships." The loss
is 0.4pp. The battery's standard per-locale floor tolerance is 1pp, so it sits inside the usual slack
and outside the bar as written; the bar governs.

## Mechanism

Turning the choreography off makes the model read the gazetteer clue next to a postcode instead of
deciding structurally. Decode margins, crossed by region and name shape on the stratified US panel:

| group          | rows | decoded as locality, v5.7.0 | v5.8.0 | what won instead in v5.8.0        |
| -------------- | ---: | --------------------------: | -----: | --------------------------------- |
| CA suffix tail |   13 |                        7.7% |  76.9% | `B-street` 3                      |
| IL suffix tail |    8 |                       25.0% | 100.0% | —                                 |
| CA multi-word  |    8 |                       50.0% | 100.0% | —                                 |
| VT multi-word  |   24 |                      100.0% |  54.2% | `B-street_prefix` 9, `B-street` 2 |
| VT suffix tail |   16 |                       93.8% |  62.5% | `B-street` 5, `B-street_prefix` 1 |
| VT single word |   40 |                      100.0% |  90.0% | `B-street` 4                      |

One change, three symptoms:

1. **Localities recovered.** `Orland Park, IL 60467` answers its locality.
2. **Street-shaped localities lost.** `East Haven, VT 05837` returns `"East"`. The rest are
   `West Rutland`, `Mount Holly`, `South Hero`, `Barre Town`, `Essex Junction Village`.
3. **Venues absorbed into the locality.** `Le Colimaçon, 44 Rue Vieille du Temple, 75004 Paris, France`
   returns venue null and locality `"Le Colimaçon"`. Seven of the ten D-rule regressions are a venue
   that used to extract and now returns null. FR venue F1 66.7% → 50.0% (n=1546); US venue 96.9% →
   95.0% (n=2660).

   The FR half of that line reports a denominator the measurement does not have. `n=1546` is the row
   count of `fr.jsonl`, and 1 of those rows carries a gold venue, so the FR venue reading is
   `tp: 1, fp: 1, fn: 0` and 66.7% → 50.0% is one row moving. The US half stands: 970 of the 2,660
   rows carry a gold venue. FR and GB venue behavior is graded by the regression board alone, so the
   seven regressions above are what this point rests on rather than the FR F1.

The clue fires where the locality lexicon holds the name and is silent where it does not, and when it
is silent the name's shape decides. Lexicon coverage tracks the direction — IL 91.3% (63/69) and CA
68.2% (15/22) both gain; VT 57.0% (81/142) and MT 48.1% (51/106) both lose. Across the panel the rows
v5.8.0 gains are 82.9% in-lexicon (34/41) against a 52.3% base rate (277/530). Coverage does not
account for every row: SD sits at 35.8% (38/106) and neither gains nor loses, and 7 of Vermont's 16
lost rows are in the lexicon.

## Per-state panel movement

| state | rows | v5.7.0 | v5.8.0 | gained | lost |
| ----- | ---: | -----: | -----: | -----: | ---: |
| IL    |   69 |  71.0% |  97.1% |     18 |    0 |
| CA    |   22 |  36.4% | 100.0% |     14 |    0 |
| IA    |  157 |  94.3% |  96.8% |      8 |    4 |
| SD    |  106 |  99.1% | 100.0% |      1 |    0 |
| MT    |  106 |  96.2% |  91.5% |      0 |    5 |
| VT    |  142 | 100.0% |  88.7% |      0 |   16 |
| DC    |    1 | 100.0% | 100.0% |      0 |    0 |

## What the run establishes

The choreography is the cause of the bare `locality, REGION postcode` defect, and the corpus gap is
not its only cause. CA suffix-tail localities move 7.7% → 76.9% and IL suffix-tail 25% → 100% from the
training flag alone, with no corpus change.

## Pre-registration defect, for the next arm

Bar 1 is a pooled US rate plus a name-shape bucket, and neither is conditioned on region. Pooled, the
panel reads 94.7% and passes while Vermont falls from 142/142 to 126/142. The same arc had already
measured a 100-point per-region spread on this surface. Condition the next pre-registration on region.

## Next arm

Leave `gazetteer_choreography` on and add the bare `locality, REGION postcode` surface to the US
corpus. The #2303 diagnosis was that no US recipe put a locality in front of a region code and a
postcode without a street ahead of it. That targets the gap without changing which evidence the model
trusts for every input, which is what cost the venues and the Vermont names here.

## Artifacts

- Checkpoint: `output-v580-gazetteer-choreography-off-s42/checkpoints/step-060000` on the training volume
- fp32 export md5 `bee60506df01c998dd39e89868e361e3`, 157.1 MB
- int8 md5 `ad582b045a9dde35f3ccb140aac57403`, 39,419,640 bytes
- Candidate cache `$MAILWOMAN_DATA_ROOT/candidates/v580-cache`; control `v570-cache-fr`
- Final training validation: val_loss 0.715332, val_macro_f1 0.895982 (v5.7.0: 0.727783 / 0.898163)

## Staging trap

A staged candidate cache symlinks `model-card.json` into one shared file under
`$MAILWOMAN_DATA_ROOT/weights/<locale>/`, so two arms share the inode. Editing a candidate's card in
place changes the control's card as well, with no error, and both arms then grade under the same
`requires` block. Replace the symlink with a real file and read the value back off disk for both arms
before grading. The control cache also had to be re-staged: the default locale set omits `fr-fr`, and
grading FR base-only against a candidate carrying the overlay would vary two things at once.
