---
title: "Venue fine-tune arc — v7.3.0, v7.3.1 and v7.3.2 graded against the placebo"
description: Three 4,000-step fine-tunes of the v7.2.0 graph with the venue recipe rows, graded on the regression board with the self-control, the placebo and the promotion battery, and the row-level mechanisms behind each verdict.
---

# Venue fine-tune arc — v7.3.0, v7.3.1 and v7.3.2 graded against the placebo

This record grades three fine-tunes of the shipped 10.1.0 graph (`v7.2.0-address-systems`, step 60,000)
with the rows of the `venue` corpus recipe (#2511), under the protocol in the `training-arc` skill. A
placebo fine-tune with no added rows prices the fine-tune itself, and every regression count below is
read beside it.

## Inputs

| input           | value                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base checkpoint | `/data/output-v720-address-systems-s42/checkpoints/step-060000` with its Fisher diagonal                                                                                                                 |
| Fine-tune shape | `train.init_from` the base, EWC 1e4 against the base's Fisher, learning rate 1e-5, warmup 100, 4,000 steps at batch 128 (512,000 samples), seed 42                                                       |
| Mixture         | The base config's `source_reps` divided by 15 (60,000 / 4,000 steps), so each inherited source's derived weight equals the base run's                                                                    |
| Venue rows      | 532,012 `spliced-venue-locality` and 474,821 `fragment-venue-bare` rows over 27 countries from `mailwoman corpus slice venue --seed 73` on Overture 2026-09-23.1                                         |
| Placebo         | `v7.3.0-null-4k.yaml`, corpus `0.7.2-address-systems`, Modal app ap-w9wLj6nWbIvFgx5vcKwRlN                                                                                                               |
| Treatment 1     | `v7.3.0-venue-4k.yaml`, corpus `0.7.3-venue`, venue share 5% of draws, half the locality rows end `, <region>`, app ap-4Rfsh5hJyxDAcEPaq9Jz2F                                                            |
| Treatment 2     | `v7.3.1-venue-nr-4k.yaml`, corpus `0.7.3.1-venue-nr`, venue share 3%, `--venue-region-fraction 0`, app ap-cirj89g8WtyTD2vjVn9LUi                                                                         |
| Treatment 3     | `v7.3.2-venue-planet-4k.yaml`, corpus `0.7.3.2-venue-planet` (1,637,640 locality and 1,478,399 bare rows over 147 countries), venue share 3%, `--venue-region-fraction 0`, app ap-EwnlXTzUKbFRU2XXLlu7lp |
| Board           | The 1,226-row regression board, corpus `1fc9dad1eef7`, per-row country routing, graded on `main` at `9c296f82b`                                                                                          |
| Staging         | Every weights locale as dereferenced copies; the candidate graph replaces `model.onnx` in en-us and en-gb, the two locales whose shipped graph is the en-us graph                                        |
| Date            | 2026-10-10                                                                                                                                                                                               |

Each run's epoch-mixture audit passed every receipt. Treatment 1 needed the inherited receipt floors
times 0.95, because `ve-locality-postcode-region` drew 197 against the base's floor of 200 once the
venue rows took 5% of the mixture; treatment 2 scales them by 0.97. Treatment 3 scales them by 0.97 and
again by 0.9, after a first audit drew 185 for `ve-locality-postcode-region` against a floor of 194, with
every large source within 1% of its treatment 2 draw.

## Board grades against shipped 10.1.0

| arm                                   | improved | regressed | net | rows differing |
| ------------------------------------- | -------: | --------: | --: | -------------: |
| self-control (staged copy of shipped) |        0 |         0 |   0 |     0 of 1,226 |
| placebo v730-null-4k                  |        5 |         4 |  +1 |    34 of 1,226 |
| treatment 1, v730-venue-4k            |       13 |        20 |  −7 |   109 of 1,226 |
| treatment 2, v731-venue-nr-4k         |       12 |         5 |  +7 |    70 of 1,226 |
| treatment 3, v732-venue-planet-4k     |       22 |        11 | +11 |   102 of 1,226 |

Attributable to the venue rows, treatment minus placebo: treatment 1 net −8 with 16 regressions,
treatment 2 net +6 with 1 regression, treatment 3 net +10 with 7 regressions.

The self-control differed on 0 rows only with per-row country routing and every locale staged. A root
holding en-us alone differed on 27 rows, all Han-script CN, JP and SG rows, which fall back to the en-us
model when the root has no CJK package.

Validation on the trainer's 4,096-row draw, for the record rather than the decision: placebo val loss
0.7462 and macro F1 0.9297; treatment 1 0.7428 and 0.9357; treatment 2 0.7429 and 0.9323. The draw holds
3 `po_box` rows and none of the venue sources (#2438). Treatment 3: 0.7487 and 0.9275.

## Mechanisms, from `mwdev_diff_parse`

Treatment 1 regressed 14 thin-system rows. On 7 of 12 inspected, the city before the country was
retagged locality → region: `PLOT 211 TSHEKO ROAD MAIN MALL, GABORONE, Botswana` (`GABORONE` locality
0.48 → region 0.41), `SUITE B21, GOLDEN PEACOCK SHOPPING COMPLEX, LILONGWE, Malawi`,
`UNIT 117, JBK COMPOUND, SALWA, DOHA, Qatar`, `AL NAHDA STREET, MUSCAT, Oman`,
`1 MSASA LANE, HARARE, Zimbabwe`. Half of treatment 1's locality rows ended `, <region>`, the shape
that teaches a trailing capitalized segment as region. Treatment 2 removed that tail and those rows
returned to their shipped grade; three of them improved.

Both treatments fragment bare multi-word inputs: `Andorra la Vella` → locality `Andorra la` + region
`Vella` (treatment 1 only), `Pago Pago` → locality `Pago` + region `Pago`, `Yonge Street North` →
street `Yonge` + suffix `Street` + locality `North`. These point at the `fragment-venue-bare` rows,
multi-word bare queries labeled `venue`, competing with bare multi-word localities and streets.

Treatment 2's one GB regression, `North Irish Lodge, 161 Low Rd, Islandmagee, Larne BT40 3RF, United
Kingdom` (`gb-op2-north-irish-lodge`, status `improvement_target`), is `Islandmagee` retagged
dependent_locality → locality at confidence 0.38 → 0.38 with every other span unchanged. The placebo
regresses the row the same way.

Treatment 2 improved the issue's targets `St Mary's Church, Oxford` (treatment 1), `Paws 4 A Rest, High
Ln, Woodley, Stockport SK6 1AZ, United Kingdom`, `Rinrin, 3 Chome-57 Tenmanmachi, Takayama, Gifu
506-0025, Japan`, the counted ES row `Calle de Preciados`, and seven thin-system rows including
`ARZAT MALL, OFFICE NO: 12, MUSCAT, Oman` and `MAZOE STREET, PARIRENYATWA HOSPITAL, HARARE, Zimbabwe`.
The US row the placebo loses, `Donkey's Place Downtown, 37 Washington St Rear, Mt Holly, NJ 08060`,
passes again under treatment 2.

## Treatment 3, the 147-country corpus

Treatment 3 improves 22 rows, 14 of them in countries with no row in the 27-country corpus: Albania,
Burkina Faso, Botswana, Côte d'Ivoire, Costa Rica, Ecuador, Oman, Papua New Guinea, Qatar, Uganda,
Zimbabwe and the United Arab Emirates. It keeps treatment 2's GB and JP improvements. Its 11 regressions
spread over BF 1, BR 2, CA 1, CN 3, CZ 1, GB 2 and VI 1. The CZ row and one GB row
(`Mischicks Day Spa - St Andrews Lakes - Rochester, Kent, Quarry Grv, Halling, Rochester ME2 1FW`)
regress under the placebo as well. The other GB row, `Boulevard London, Regent Park, 12-14 Lodge Rd,
London NW8 7JA`, is attributable to the venue rows. The three CN rows are Heilongjiang farm-division
addresses (`长水河十五分场场部, HEILONGJIANG` and two more), and the CA row `Swiss Chalet, 92 Laurel Rd,
Gander, NL A1V 0A9, Canada` is a tracked venue row that the venue tier promotes under the shipped graph.

The promotion battery `v9.0.0-base.json` on the staged treatment 3 weights grades FAIL: `us.region` 88.3
against a floor of 89.4 and `fr.region` 35.5 against 36.7, with the other 16 floors passing. Treatment 3
therefore cannot ship, and the attributable GB regression would hold it under the D-rule regardless.
The 147-country corpus is the corpus for the next from-scratch run, where a region floor is set by
the run rather than inherited.

## Ship floors for treatment 2

1. Net improved minus regressed on the full board: +7. Holds.
2. Promotion battery `v9.0.0-base.json` on the staged weights: 18 of 18 floors pass; int8 within 0.1
   of fp32 on every metric. Holds.
3. FR, GB and DE regressions: one GB row, tracked, lost by the placebo as well. The D-rule reads the
   shipped comparison, so the arc tool reports a hold, and the exception is the operator's.

## Artifacts

| artifact         | location                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Treatment 2 int8 | Modal volume `/models/quantized/model-v731-venue-nr-step-004000-int8.onnx`, md5 `c4c8d8c49f884ce073bd144797cd4f15`                                                       |
| Treatment 3 int8 | `/models/quantized/model-v732-venue-planet-step-004000-int8.onnx`, md5 `8c8fa58f6b8b03a8a8d5c5bc0bf1798a`                                                                |
| Treatment 1 int8 | `/models/quantized/model-v730-venue-step-004000-int8.onnx`, md5 `37e71fbf…`                                                                                              |
| Placebo int8     | `/models/quantized/model-v730-null-step-004000-int8.onnx`, md5 `30611ab8…`                                                                                               |
| Epoch audits     | `/audits/epoch-mixture-v7.3.0-null-4k.json`, `…-v7.3.0-venue-4k.json`, `…-v7.3.1-venue-nr-4k.json`, `…-v7.3.2-venue-planet-4k.json`                                      |
| Board runs       | `mwdev_runs` ids `2cc652ab`, `de80c475`, `e149030f` (treatment 2), `57860ce3`, `d81a5960`, `c7a1f8a4` (treatment 1) and `550c32b0`, `8326dbba`, `ea3297f8` (treatment 3) |

Spend: four 4,000-step A100 runs of about 22 minutes each and five CPU audits, about $5 of Modal
time by the training-arc skill's per-run figure.
