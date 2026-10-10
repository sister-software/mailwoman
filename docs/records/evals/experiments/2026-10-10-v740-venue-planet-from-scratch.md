---
title: "v7.4.0 from scratch over the 147-country venue corpus — graded against shipped 10.1.0"
description: The first from-scratch run after v7.2.0, over 0.7.3.2-venue-planet with the per-label validation floor, with its audits, training curve, per-label support, board grade and promotion battery.
---

# v7.4.0 from scratch over the 147-country venue corpus — graded against shipped 10.1.0

`v7.4.0-venue-planet-60k.yaml` trains the v7.2.0 run shape from scratch over the `0.7.3.2-venue-planet`
corpus (#2511), under the per-label validation floor and the `support.<tag>` columns of #2438. This record
grades it under the `training-arc` skill. A from-scratch run inherits no base, so the shipped model is the
baseline and no placebo applies.

## Inputs

| input     | value                                                                                                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config    | `corpus-python/src/mailwoman_train/configs/v7.4.0-venue-planet-60k.yaml`: no `init_from`, 60,000 steps at batch 128, learning rate 5e-4, cosine, seed 42                                                                                                             |
| Corpus    | `0.7.3.2-venue-planet` over `0.7.2-address-systems`: 1,637,640 `spliced-venue-locality` and 1,478,399 `fragment-venue-bare` rows over 147 countries                                                                                                                  |
| Mixture   | Venue reps 0.07394, 3% of draws; inherited receipt floors at the base's times 0.97 times 0.9; 215 admitted countries                                                                                                                                                 |
| Floors    | 44 corpus receipts, 22 validation-coverage floors, one label floor (`unit` at 500 validation rows)                                                                                                                                                                   |
| Run       | Modal app `ap-MS66fbMNKwT1p5hxsPYWK0`, A100-SXM4-40GB, 39,292,118 parameters, 4.9 steps per second, about 3.4 hours                                                                                                                                                  |
| Artifacts | `/data/output-v740-venue-planet-s42/checkpoints/step-060000` with `fisher-diag-v1.npz`; fp32 `model.onnx` md5 `247516327f33d57914e81bd73e4d7b90`; int8 `/data/models/quantized/model-v740-venue-planet-step-060000-int8.onnx` md5 `19dd3d592acbd3a926c638f97546848b` |
| Board     | The 1,226-row regression board, corpus `1fc9dad1eef7`, per-row country routing, candidate staged into en-us and en-gb with every locale present                                                                                                                      |
| Date      | 2026-10-10                                                                                                                                                                                                                                                           |

## Audits

The epoch-mixture audit over a 1,000,000-row window passed all 44 receipts: `spliced-venue-locality` drew
15,781 against 14,180, `fragment-venue-bare` 14,306 against 12,810, `ve-locality-postcode-region` 213 against 174. The validation-coverage audit passed every floor. The label-support audit on the trainer's 4,096-row
validation draw counted `unit` 745 rows against the floor of 500 and `po_box` 3 rows, as #2438 recorded.

## Training

Train loss fell from 5.04 at step 100 to 0.69 at step 60,000. The final eval on the 4,096-row validation
draw: val loss 0.7821, macro F1 0.8848. v7.2.0's final eval read 0.7462 and 0.9297 on its own draw of the
`0.7.2` corpus. The two draws differ by the venue rows the new corpus adds, so the two figures are not one
comparison.

Per-label F1 and piece support at step 60,000, from `train_log.csv`:

| label                |    F1 | support |
| -------------------- | ----: | ------: |
| `country`            | 1.000 |     120 |
| `postcode`           | 1.000 |  22,337 |
| `house_number`       | 0.993 |  11,458 |
| `street`             | 0.954 |  22,723 |
| `region`             | 0.942 |   3,332 |
| `locality`           | 0.933 |  15,708 |
| `street_prefix`      | 0.928 |   1,879 |
| `unit`               | 0.920 |   1,908 |
| `venue`              | 0.883 |   6,795 |
| `street_suffix`      | 0.831 |   3,910 |
| `po_box`             | 0.766 |      19 |
| `dependent_locality` | 0.468 |     182 |

`po_box` F1 moved between 0.150 and 0.957 across the 30 evals on 19 pieces, and enters the macro score as one
equal term. The support column now shows that beside the number. `subregion`, `cedex`, `intersection_a` and
`intersection_b` have no validation support and no F1.

## Board grade against shipped 10.1.0

| leg                                   | improved | regressed | net | rows differing |
| ------------------------------------- | -------: | --------: | --: | -------------: |
| self-control (staged copy of shipped) |        0 |         0 |   0 |     0 of 1,226 |
| candidate v740-venue-planet-60k       |       76 |        74 |  +2 |   362 of 1,226 |

A from-scratch run inherits no base, so the comparison against shipped is the attributable one and no
placebo applies (`mwdev_runs` 7724573c and 29a3359c). The verdict is hold: regressions on GB 9, US 3,
FR 2 and DE 1 refuse a default-on ship under the D-rule whatever the net.

The improvements are concentrated where the venue corpus added rows: 21 thin-system rows in Côte
d'Ivoire, Uganda, Malawi, Botswana, Qatar, Oman and Armenia, four Han-script CN rows, the venue targets
`St Mary's Church, Oxford`, `Paws 4 A Rest, High Ln, Woodley, Stockport SK6 1AZ, United Kingdom`,
`A Bar with Shapes for a Name, 232 Kingsland Rd, Whitmore Estate, London E2 8AX, United Kingdom` and
`りんりん, 〒506-0025 岐阜県高山市天満町3丁目 57`, and four bare US `locality, region postcode` rows.

The regressions carry one mechanism in the majority of the sampled rows, from `mwdev_diff_parse` against
shipped: a bare street name is retagged `venue`. `Calle de Fuencarral` street 0.73 → venue 0.58;
`Paseo de la Reforma` street 0.83 → venue 0.85; `Marylebone High Street` street + suffix 0.94 → venue
0.58 over the whole phrase; `Neusser Str. 12, Nippes, 50733 Köln` street 0.88 → venue 0.72 with the
house number swallowed. The `fragment-venue-bare` rows, bare multi-word names labeled `venue` at a 3%
share from step 0, compete with bare multi-word streets, which the v7.3.x fine-tunes showed on
`Pago Pago` and `Yonge Street North` and a from-scratch run shows across the bare-street rows of six
countries. A second mechanism retags a trailing directional as `region`: `King Street East` → locality
`King Street` + region `East` 0.25, `Constitution Avenue Northwest` → street `Constitution Avenue` 0.41 +
region `Northwest` 0.44. A third lowers admin confidence on venue-led GB rows: `1947 London, 4 Great
Portland St, London W1W 8QJ` loses `London` from the venue and retags the trailing `London` region 0.42.

## Promotion battery

`mwdev_promotion_eval` with `v9.0.0-base.json` on the staged root misses two floors: 16 of 18 pass.
`us.postcode` reads 92.2 against a floor of 93.7 and `us.region` 85.7 against 89.4. `fr.region` reads
45.7 against 36.7, `us.street` 81.5 against 67.7, `us.unit_real` 97.0 against 73.0 and `fr.bare_street_intact`
100 against 75. The per-locale macro F1 on the golden dev split reads US 61.2% and FR 52.3%.

## Decision

v7.4.0 does not ship: the D-rule refuses it on four locales and the battery misses two US floors. The run
answers the question #2511 left open, whether the venue rows belong in a from-scratch base at this share:
the venue and thin-system rows improve, and the bare-street rows pay for them. The next arm keeps
`spliced-venue-locality` and removes or lowers the share of `fragment-venue-bare`, whose bare multi-word names are the
rows that compete with bare streets, or pairs it with a bare-street fragment source at equal share so the
model sees both readings of a bare multi-word name. The v7.3.1 fine-tune (net +6 attributable, 18 of 18
floors, one tracked GB row the placebo also loses) remains the only candidate that clears the battery.
