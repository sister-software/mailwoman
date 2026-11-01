# Postcode-move training runs on corpus v0.8.0 (#2750)

Three from-scratch runs of 60,000 steps each trained on corpus v0.8.0 with seed 42. They differ only in
`augment_postcode_move_prob`, the training-time rate at which a row's postcode moves across its admin tail: 0 (p000),
0.05 (p005) and 0.15 (p015). Their configs are `corpus-python/src/mailwoman_train/configs/v8.0.0-postcode-move-p{000,005,015}-60k.yaml`.
Each run has one seed. Every number below measures these three artifacts, and none estimates seed noise.

The comparison arm is the published model 10.7.0 (v7.10.0-gb-county, int8 md5 `5356ecba83e3774a5d9717277c051ac2`). p000
is the in-batch control for the copy rate.

| Run  | Copy rate | int8 md5                           | fp32 md5                           |
| ---- | --------- | ---------------------------------- | ---------------------------------- |
| p000 | 0         | `856ce120c69622026518269de27e9b98` | `9c47816659fa67ba3ff30f50a1851d92` |
| p005 | 0.05      | `26daa4e4a312dac16a6f0b1db6a4e294` | `2acd69ca670834c5bd4192ddcf763cef` |
| p015 | 0.15      | `81bc943c3008f3d6f849c7339d5a76b0` | `76433d3ebdac540550d9fb2d9214d5e5` |

## Run history

p005 and p015 stopped near steps 22,700 and 22,600 with `ValueError: spans overlap: postcode@[34, 39) overlaps [23, 40)`.
The move's offset shift treated a span ending exactly where the moved block began as inside the block. In
`THERESA TEBBETT 99 MAIN ST HEPSTEAD NY 11550`, the street span grew over the moved postcode
(`…MAIN ST11550  HEPSTEAD NY`). Commit 434aad7e0 fixes the shift and refuses three shapes with explicit outcomes. A sweep of
10,336,567 v0.8.0 train rows moved 5,772,255. Before the fix, 24 of the moved rows failed span validation, and after it,
0 did. The new refusals remove 100 moves, 0.0017% of all moves. Both runs resumed from `step-020000` on the fixed code.
Modal preempted p015 after step 30,000, and the run resumed from `step-030000` by itself.

## Results

### Regression board, against 10.7.0 (1,277 rows)

The staged copy of 10.7.0 matched the installed weights on all 1,277 rows.

| Run  | Improved | Regressed | Net | US / GB / FR / DE regressed |
| ---- | -------: | --------: | --: | --------------------------- |
| p000 |       61 |        63 |  −2 | 10 / 12 / 0 / 0             |
| p005 |       72 |        43 | +29 | 7 / 8 / 1 / 0               |
| p015 |       74 |        54 | +20 | 7 / 10 / 0 / 0              |

Against p000, p005 nets +26 (61 better, 35 worse) and p015 nets +22 (61 better, 39 worse).

### Promotion battery v9.0.0-base (18 floors)

10.7.0, rerun in the same session, passes 15 of 18. Each run passes 16 of 18. All three miss `us.postcode` (floor 93.7,
at 92.4, 91.2 and 91.3) and `us.region` (floor 89.4, at 87.8, 87.9 and 88.1). All three pass `fr.postcode` (floor 98.8) and
`fr.house_number` (floor 96.6), which 10.7.0 misses at 98.6 and 96.5.

### Release requirements v7 on `heldout-dev-v0.8.0`

The development set holds 55,794 rows. Its overlap audit admits 16,173 `verified_unseen` rows that no model trained
on, and 27,621 `unseen_by_candidate` rows that only 10.7.0 trained on. Every run's verdict is `fail`. 10.7.0 graded
against itself also reads `fail`, on IT, AU, NZ, `po_box_cedex` and `postal_unit`.

The pooled exact-parse rates hide a provenance split. The table separates the two row classes. A cell under 30 groups is
too small to compare.

| Check       | Rows                    | 10.7.0 |  p000 |  p005 |  p015 |
| ----------- | ----------------------- | -----: | ----: | ----: | ----: |
| venue_unit  | 94 verified_unseen      |  0.968 | 0.947 | 0.872 | 0.404 |
| venue_unit  | 327 unseen_by_candidate |  0.951 | 0.046 | 0.003 | 0.000 |
| ES          | 997 unseen_by_candidate |  0.945 | 0.633 | 0.628 | 0.616 |
| GB          | 1,000 verified_unseen   |  0.783 | 0.930 | 0.946 | 0.945 |
| DE          | 1,000 verified_unseen   |  0.817 | 0.851 | 0.844 | 0.801 |
| IN          | 994 verified_unseen     |  0.884 | 0.921 | 0.945 | 0.874 |
| NZ          | 962 verified_unseen     |  0.042 | 0.322 | 0.384 | 0.394 |
| IT          | 635 verified_unseen     |  0.000 | 0.000 | 0.000 | 0.000 |
| postal_unit | 1,775 verified_unseen   |  0.066 | 0.297 | 0.339 | 0.349 |
| US          | 993 unseen_by_candidate |  0.754 | 0.766 | 0.690 | 0.744 |

Observed:

- On venue_unit rows no model trained on, p000 is within 2 of 94 groups of 10.7.0. p005 is 7 groups below p000 and p015
  is 51 groups below. That p015 fall is the one copy-rate effect in this grading larger than a few groups.
- On the 327 venue_unit rows only 10.7.0 trained on, every run scores near 0. Both corpora hold 120,000 train rows of
  `spliced-sub-venue` at weight 12.0.
- ES has 3 verified_unseen groups, too few to compare. Its whole loss is in rows 10.7.0 trained on.
- Every model, 10.7.0 included, scores 0 of 635 on IT's verified_unseen rows.

Inferred, and unverified:

- The 327 venue_unit rows and the 997 ES rows were written in a form the v0.8.0 rows of the same sources no longer teach.
  A run that merely lacked these rows would score near its verified_unseen rate, 0.947 for p000.
  `packages/corpus/AGENTS.md` records that `spliced-sub-venue` changed its inputs. Comparing a sample of those rows'
  gold spans with v0.8.0 `spliced-sub-venue` train rows would distinguish a rendering change from a labeling change.
- A 0 of 635 rate in every model points to a mismatch between IT's gold spans and what any model emits.

### Non-native postcode sweep

The sweep was generated from the v0.8.0 test split and holds 1,000 rows that are not on the board. Only FR and US produced
rows (500 each), so it measures those two of the ten requested countries. Postcode recovery is 990 to 992 of
1,000 in every model. Full-component exact match is 738 for 10.7.0, 759 for p000, 749 for p005 and 758 for p015. Against
p000, the copy rate gives −10 (p005) and −1 (p015).

### `30 Rockefeller Plaza, New York, NY 10112` (#2738)

10.7.0 tags `30` as venue (0.52). Every run tags it house_number (p000 0.66, p005 0.63, p015 0.63). `Plaza` stays
street_suffix at lower confidence: 0.82 in 10.7.0, and 0.70, 0.60 and 0.58 in the runs. Every span keeps its boundaries.
p000 has the change too, so it comes from corpus v0.8.0 or the run, and the move plays no part in it.

## Decision

None of the three runs can ship. Each fails release requirements v7, each misses `us.postcode` and `us.region` in the
promotion battery, and each regresses US and GB board rows.

On this evidence the copy rate has no consistent effect. The board favours p005 and p015 over p000. The postcode sweep
does not. On the held-out set, p015 falls furthest on venue_unit and DE.

The ES and venue_unit losses are shared by all three runs, p000 included, so they belong to corpus v0.8.0 rather than to
the move. The next measurement is the comparison of those rows' gold spans with the v0.8.0 training rows of the same
sources.
