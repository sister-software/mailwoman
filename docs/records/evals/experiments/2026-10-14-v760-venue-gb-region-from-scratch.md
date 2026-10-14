---
title: "v7.6.0 from scratch over venue-with-locality rows and the GB constituent-country relabel — graded against shipped 10.1.0"
description: One from-scratch run that tests the two queued corpus hypotheses, `fragment-venue-bare` at weight 0 and `rendered-gb` v2 labeling the constituent country `region`, with its audits, training curve on a proportional validation draw, board grade and promotion battery.
---

# v7.6.0 from scratch over venue-with-locality rows and the GB constituent-country relabel — graded against shipped 10.1.0

`v7.6.0-venue-gb-region-60k.yaml` trains the v7.4.1 run shape from scratch over the `0.7.6-venue-gb-region`
corpus (#2568). The corpus is `0.7.3.2-venue-planet` with its three `rendered-gb` files replaced by the
`rendered-gb` v2 split files. Those files label the GB constituent country `region` after the locality (#2554).
The config keeps `fragment-venue-bare` at weight 0, the arm v7.4.0's record proposed, and `spliced-venue-locality`
at reps 0.07394. One run therefore tests both queued hypotheses. This record grades it under the `training-arc`
skill. A from-scratch run inherits no base, so the shipped model is the baseline and no placebo applies.

## Inputs

| input     | value                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Config    | `corpus-python/src/mailwoman_train/configs/v7.6.0-venue-gb-region-60k.yaml`: no `init_from`, 60,000 steps at batch 128, learning rate 5e-4, cosine, seed 42, `val_rows` 8,192                                                                                                        |
| Corpus    | `0.7.6-venue-gb-region`: `0.7.3.2-venue-planet` with `rendered-gb` replaced by v2 (train 789,677, val 5,166, test 5,157 rows), assembled by `mailwoman corpus overlay-manifest --replace-source rendered-gb`                                                                         |
| Mixture   | `spliced-venue-locality` reps 0.07394, `fragment-venue-bare` weight 0, `rendered-gb` weight 6 under its unchanged wire identifier                                                                                                                                                    |
| Floors    | 44 corpus receipts including the new `gb-constituent-country-region` (1,000 GB `rendered-gb` rows with `locality` then `region`), the validation-coverage floors, the `unit` label floor of 500 validation rows                                                                      |
| Run       | Modal app `ap-U1oREOiYONb0oNXmvh8XTg`, A100-SXM4-40GB, 39,292,118 parameters, 3.6 to 3.7 steps per second, 4 hours 37 minutes from 14:07 to 18:51 BST                                                                                                                                |
| Artifacts | `/data/output-v760-venue-gb-region-s42/checkpoints/step-060000`; fp32 `model.onnx` md5 `ba87ff3c56c40c0cfd889e418f5a0e87`; int8 `/data/models/quantized/model-v760-venue-gb-region-step-060000-int8.onnx` md5 `a1ba5c8cadc7970d434e08e17dfbcb66`, 39,452,103 bytes, verified locally |
| Board     | The 1,265-row regression board, per-row country routing, candidate staged into en-us and en-gb with every locale present                                                                                                                                                             |
| Date      | 2026-10-14                                                                                                                                                                                                                                                                           |

## Audits

The epoch-mixture audit over a 1,000,000-row window passed all 44 receipts: `gb-constituent-country-region`
drew 7,154 against 1,000, `spliced-venue-locality-exposure` 15,864 against 14,180, `ve-locality-postcode-region`
204 against 174. The validation-coverage audit passed every floor. The label-support audit on the trainer's
8,192-row validation draw counted `unit` 762 rows (9.3%) against the floor of 500.

## The validation draw

The trainer's limited validation draw changed in this run. `_stream_held_out` shuffled the split's file order
and streamed each file whole into the 131,072-row buffer, so a 4,096-row draw was the leading file's rows.
Over the same 36-file split, the draw held 745 rows with `unit` under one file order and 64 under another,
where the split holds 9.0%. The loader now takes each file's share of the draw and spreads that share over
the file's row groups. `val_rows` rises to 8,192 so the `unit` floor is met on the proportional draw.

The `train_log.csv` validation metrics of v7.2.0 and v7.4.0 were measured over the earlier, file-dominated
draw. Their val loss and per-label F1 are not comparable with this run's figures, and the per-label support
columns of those runs describe whichever files led their shuffled order.

## The training run

Train loss fell from 5.00 at step 100 to 0.66 at step 60,000. Val loss on the 8,192-row proportional draw
read 0.838 at step 10,000, 0.777 at 30,000 and 0.735 at 60,000, with macro F1 0.849, 0.874 and 0.883.

Per-label F1 and piece support at step 60,000, from `train_log.csv`:

| label                |    F1 | support |
| -------------------- | ----: | ------: |
| `country`            | 1.000 |     627 |
| `postcode`           | 1.000 |  41,598 |
| `house_number`       | 0.995 |  19,492 |
| `locality`           | 0.969 |  39,964 |
| `unit`               | 0.954 |   2,525 |
| `street`             | 0.947 |  42,368 |
| `venue`              | 0.923 |   5,669 |
| `street_prefix`      | 0.906 |   4,055 |
| `region`             | 0.871 |   6,457 |
| `street_suffix`      | 0.772 |   8,400 |
| `dependent_locality` | 0.379 |     457 |

`po_box`, `subregion`, `cedex`, `intersection_a` and `intersection_b` have no support in this draw and no F1.
`po_box` had 19 pieces in v7.4.0's draw, where it entered the macro score as one equal term.

## What the constituent-country relabel could teach

The `rendered-gb` recipe renders Land Registry Price Paid rows, and that register covers England and Wales.
The v2 train split holds zero rows in the EH, G, AB, KY, DD and BT postcode areas, and its `region` spans
are `England` 229,902 and `Wales` 7,442. The relabel teaches England and Wales only. Every Scottish and
Northern Irish address the model sees comes from other sources, under their own labels. The parses match,
from `mwdev_diff_parse` against shipped under `en-GB`:

| input                                         | shipped 10.1.0                                                     | candidate v7.6.0                                                     |
| --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `10 High Street, Cardiff, Wales`              | locality `Wales` 0.51                                              | region `Wales` 0.95                                                  |
| `1 Market Street, Manchester, England`        | country `England` 0.97                                             | region `England` 0.94                                                |
| `5 Princes Street, Edinburgh, Scotland`       | locality `Scotland` 0.95                                           | locality `Scotland` 0.91                                             |
| `12 Castle Street, Belfast, Northern Ireland` | locality `Belfast` 0.93, region `Northern` 0.73, country `Ireland` | locality `Belfast` 0.80, locality `Northern` 0.59, country `Ireland` |

Under the default locale the candidate parses `Belfast` in the fourth input as venue at 0.01. Scotland and
Northern Ireland need a source that holds their addresses before a relabel can reach them.

## Board grade against shipped 10.1.0

| leg                                   | improved | regressed | net | rows differing |
| ------------------------------------- | -------: | --------: | --: | -------------: |
| self-control (staged copy of shipped) |        0 |         0 |   0 |     0 of 1,265 |
| candidate v760-venue-gb-region-60k    |       74 |        76 |  -2 |   317 of 1,265 |

The comparison against shipped is the attributable one (`mwdev_runs` 6be5a012 and 2cb660a3). The verdict is
hold: regressions on GB 8 and US 7 refuse a default-on ship under the D-rule, and the net is below zero.
FR and DE regress on zero rows, where v7.4.0 regressed FR 2 and DE 1.

The bare multi-word streets that v7.4.0 retagged `venue` mostly hold: `Calle de Fuencarral` street 0.73 →
0.90, `Marylebone High Street` street + suffix unchanged, `Neusser Str. 12, Nippes, 50733 Köln` keeps every
tag with street confidence 0.88 → 0.55. `Calle de Alcalá`, `Calle de Preciados`, `Passeig de Gràcia`,
`Via del Corso`, `Corso Vittorio Emanuele II`, `Via della Conciliazione` and `Avenida de Roma` improve.
`Paseo de la Reforma` still splits, into venue `Paseo` 0.32 and street `de la Reforma` 0.53.

The improvements otherwise fall where v7.4.0's did: thin-system rows in Botswana, Uganda, Burkina Faso,
Côte d'Ivoire, Malawi, Oman and Qatar, four Han-script CN rows, the venue targets
`A Bar with Shapes for a Name, 232 Kingsland Rd, Whitmore Estate, London E2 8AX, United Kingdom`,
`Paws 4 A Rest, High Ln, Woodley, Stockport SK6 1AZ, United Kingdom`, `Newport, Wales`, and three bare US
`locality, region postcode` rows.

The regressions show two mechanisms in the sampled GB and US rows, from `mwdev_diff_parse` against shipped:

1. A bare US locality before `region postcode` is read as a street: `Medicine Lodge, KS 67104` locality
   0.30 → street `Medicine` 0.86 + suffix `Lodge` 0.85; `La Harpe, KS 66751` locality 0.39 → street 0.69;
   `Center Barnstead, NH 03225` locality 0.42 → prefix `Center` + street `Barnstead`; `Crocketts Bluff, AR 72038`
   likewise. v7.4.0 improved four rows of this shape. The shipped confidences were 0.30 to 0.62, so these rows
   were never confident.
2. A trailing directional still breaks a bare street, now toward `locality` rather than v7.4.0's `region`:
   `King Street East` street 0.56 → locality 0.46; `Madison Square West` street 0.63 → locality 0.47;
   `West Broadway` prefix + street → locality `West Broadway` 0.56; `Yonge Street North` → street `Yonge` +
   suffix + locality `North` 0.29; `Granville Street North`, `Queen Street East`, `Queen Street West` and
   `University Avenue West` are the Canadian rows of the same shape.

Venue-led GB rows regress on span boundaries rather than tags: `Al Forno, Romney Court, 4 Shepherd's Bush Grn,
London W12 8PY` folds `Romney Court` into the venue and `Grn` into the street; `Barts and The London School of
Medicine and Dentistry, Garrod Building, Turner St, London E1 2AD` folds `Garrod Building` into the venue. The
Northern Irish row `W4, The Odyssey, 2 Queens Quay, Belfast BT3 9QQ, United Kingdom` loses `Belfast` to venue
at 0.00, and `St David's, Pembrokeshire` loses its locality to venue at 0.28.

## Promotion battery

`mwdev_promotion_eval` with `v9.0.0-base.json` on the staged root misses two floors: 16 of 18 pass.
`us.postcode` reads 91.8 against a floor of 93.7 and `us.region` 85.4 against 89.4, the two floors v7.4.0
missed at 92.2 and 85.7. `us.country_homograph_f1` reads 89.8 against 64.8 where v7.4.0 read 78.3,
`fr.bare_street_intact` 92.5 against 75, `us.street` 81.2 against 67.7, `us.unit_real` 97.0 against 73.0 and
`fr.region` 43.7 against 36.7. The per-locale macro F1 on the golden dev split reads US 61.0% and FR 52.3%,
where v7.4.0 read 61.2% and 52.3%.

The battery wrote into the out-dir of v7.4.0's battery, and a `verdict.json` from 2026-10-10 sat there until
this run's verdict replaced it. The figures above come from the file written at 19:15 BST on 2026-10-14.
The `provenance.txt` beside it records the candidate's md5.

## Decision

v7.6.0 does not ship: the D-rule refuses it on GB and US and the net is -2. The run answers both queued
questions. With `fragment-venue-bare` at weight 0, the FR, DE, ES and IT bare-street regressions of v7.4.0 are
gone, and the England and Wales `region` relabel reaches the parser. The cost is a new US mechanism, a bare
locality before `region postcode` read as a street. A trailing directional still breaks a bare street under
both venue arms, on the same eight Canadian and US rows. The relabel cannot reach Scotland or Northern Ireland
from Price Paid Data. Price Paid Data holds rows for England and Wales only.

The next arm needs a source of bare US `locality, region postcode` rows at a share that competes with the
bare-street rows, and a directional-suffix fragment source so a trailing `East` or `North` is seen on a
street. Scotland and Northern Ireland need an address source before the constituent-country receipt can
cover them. The v7.3.1 fine-tune remains the only candidate that clears the battery.
