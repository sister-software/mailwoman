---
title: "Label support census — the validation rows behind each macro-F1 term in v7.2.0"
description: The receipt for `label_support` in `corpus-python/launch/census.py`, measured on v7.2.0's validation draw and a 200,000-row training draw, and the per-label floor it motivates.
---

# Label support census — the validation rows behind each macro-F1 term in v7.2.0

`label_support` in `corpus-python/launch/census.py` counts, for one training config, the rows of the
trainer's validation draw and of a training draw that hold each component label, and names the
sources and countries that supply each label's training rows. `macro_f1` in
`corpus-python/src/mailwoman_train/evaluation/metrics.py` drops zero-support labels and weighs every
other label as one equal term, so a label held by a few validation rows moves the headline score as
much as a label held by thousands. This record is the receipt behind #2438.

## Measurement

Measured on 2026-10-03 with `label_support v7.2.0-address-systems-60k.yaml`. The validation draw is the
trainer's: the `val` split, 4,096 rows, seed 43. The training draw is 200,000 rows under seed 42
through the trainer's loader, with `source_reps` resolved as the trainer resolves them.

| label                               | validation rows (of 4,096) | training rows (of 200,000) | training rows from invented or spliced sources                             |
| ----------------------------------- | -------------------------: | -------------------------: | -------------------------------------------------------------------------- |
| `cedex`                             |                          0 |                        247 | 225 from `invented-po-box-cedex`                                           |
| `intersection_a` / `intersection_b` |                          0 |                        894 | 894 from `invented-intersection`                                           |
| `po_box`                            |                          3 |                      2,458 | 2,135 from the `invented-po-box-*` sources, 225 from `deepseek-kryptonite` |
| `unit`                              |                        745 |                     12,171 | 8,423 from `spliced-sub-venue/ES`, 1,530 from `spliced-unit-v30/US`        |
| `street_suffix`                     |                      2,269 |                     39,842 | mostly G-NAF, TIGER and rendered GB rows                                   |

`po_box` therefore enters the macro score from 3 validation rows. v7.0.0's `po_box` F1 moved by −0.081
between steps 24,000 and 26,000. The validation mix also differs from the training mix:
`street_suffix` appears in 55.4% of validation rows and 19.9% of training rows.

## Real-world comparison

1,029 distinct FY2024 USAspending foreign-recipient address lines across 19 countries, matched by
pattern, give a lower bound: 57 lines (5.5%) carry a PO box (`P.O. Box`, `BP`, `Private Bag`,
`Apartado`) and 144 (14.0%) carry a unit, against 1.2% and 6.1% of training rows. The PO box share by
country: Côte d'Ivoire 10 of 62, Malawi 11 of 82, Uganda 13 of 158, Ecuador 0 of 76.

The real sources (BAN, TIGER, G-NAF, OpenAddresses, OSM) register buildings and situs points. A PO box
is a postal destination, so a building register holds none, and these registers carry few apartment
or suite numbers.

## What follows

`data.required_validation_label_support` declares a per-label row floor on the validation draw, and
`audit_label_support` fails the launch preflight below it. `train_log.csv` writes each label's piece
support beside its F1. The next from-scratch run declares floors for `po_box` and `unit` and draws
its validation rows so that they are met.
