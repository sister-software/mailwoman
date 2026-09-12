# 2026-09-12 — `v5.6.0-bare-postcode`: the shape the corpus never carried

Record of the run that taught a postcode standing alone. Read against the pre-registration in
`corpus-python/src/mailwoman_train/configs/v5.6.0-bare-postcode-60k.yaml`. Issues: #1589 (the resolver
half, closed), #1931 (the arc). The control is v5.5.0 seed 42, re-measured on this host rather than
quoted.

## 1. The run

`v5.6.0-bare-postcode-60k` seed 42, 60,000 steps, batch 128, bf16, cosine, **from scratch** — no
`train.init_from`, launched `--resume none`. v5.5.0's config verbatim except for six keys:
`data.corpus_dir`, one `source_doses` line, one `required_corpus_receipts` entry, one
`augment_exclude_sources` entry, and the output and run names. Every country weight, every source
weight, the whole model block and every train hyperparameter are unchanged, so the arm has one
variable.

Corpus **v0.30.0-bare-postcode** is a pure overlay ADD on v0.29.0: one new parquet and a manifest
naming the other 719. 720 entries, 685,598,514 rows, and 685,598,514 − 685,578,054 = 20,460 exactly.

`synth-bare-postcode`: 20,460 rows of REAL codes read from the OpenAddresses extracts, no synthesis,
each emitting a postcode and nothing else.

| Country |   Rows | Spaced | Compact |
| ------- | -----: | -----: | ------: |
| NL      | 10,000 |  5,000 |   5,000 |
| CZ      |  5,290 |  2,645 |   2,645 |
| SE      |  3,058 |  1,529 |   1,529 |
| SK      |  2,112 |  1,056 |   1,056 |

Every surface is checked through `computeQueryShape` at build time, so a surface the detector will not
read as a postcode cannot ship. All 56 held-out evaluation strings are excluded from the recipe
globally by normalized form, verified against the BUILT parquet rather than its source jsonl: 0 of 56
present.

The run was preempted by Modal at step 35,600 and resumed from `step-035000`
(`[resume-drift] none — live config matches the checkpoint's stamped state`). Final validation:
`val_loss=0.7178 macro_f1=0.9064` over 4,096 rows. Artifacts: fp32 157,069,301 bytes; int8 39,419,628
bytes, `md5 de30d64c99b74ef63c054fd54708da7f`.

## 2. The exposure, and the figure it retired

`synth-bare-postcode: 1.0` reps per row. Realized in the epoch audit bound to the shipped config bytes
(`corpus_receipt_binding a89d8e8e0fc0e38004088ef4f00baa79`, status `pass`, all 10 receipts, 715 of 715
train parquet files resolved with 0 re-rooted):

| level   | rows per 1,000,000 | share   | passes per row over the run |
| ------- | -----------------: | ------- | --------------------------- |
| drawn   |              2,652 | 0.2652% | 1.00                        |
| emitted |              2,049 | 0.2049% | 0.77                        |

The emitted level runs 23% under the draw level because augmentation expands long addresses, so a
short-row source keeps a smaller part of a fixed budget. That is not the `augment_exclude_sources`
entry: `synth-no-fragment` (0.7696) and `synth-fr-fragment` (0.7708) are not excluded and carry the
same ratio.

**The arm's stated justification was wrong, and the census says so.** The exposure was argued as
outweighing 443.7 rows per pass teaching "a leading digit group is a house number" — a figure carried
through three documents with neither its definition nor its sampling level. `census_opening_token`
re-counted both readings over the same 1,000,000 emitted rows:

| opening                               | as house_number | as postcode | reading                     |
| ------------------------------------- | --------------: | ----------: | --------------------------- |
| any digit group                       |         249,934 |      93,665 | 2.67:1 toward house_number  |
| exactly three digits                  |          53,451 |      18,140 | 2.95:1 toward house_number  |
| three then two digits                 |             273 |      18,140 | **66:1 toward postcode**    |
| the same, as a COMPLETE two-token row |           **0** |     **508** | no contrary evidence at all |

At the exact failing opening the mixture already favoured postcode 66 to 1, and v5.5.0 still read
`100 00` as a house number 0 times out of 32. 17,632 of those 18,140 rows come from
`synth-cz-pcfirst-preposition-v21` and are in-context surfaces like `100 00 Praha, Czechia`, which the
0/32 result had already shown do not transfer.

What separates `100 00` from `100 00 Praha, Czechia` is that the row ENDS after two tokens. Counted
that way the mixture carries 508 rows per 1,000,000 emitted, 3,901 over the run, every one from this
source, against zero labeled house_number at either level and zero of any kind before v0.30.0. The
quantity was a shape going from absent to present, never a margin over rival evidence.

## 3. The pre-registered watch

Graded in the order the pre-registration set, both artifacts, against the v5.5.0 control re-run on
this host the same night.

### 1. The held-out sweep — PASS

56 reserved strings, none in training. `mailwoman eval bare-postcode`.

| family                               | v5.5.0 | v5.6.0 fp32 | v5.6.0 int8 |
| ------------------------------------ | -----: | ----------: | ----------: |
| `nnn_nn` (32 CZ/SK) read as postcode |   0/32 |   **31/32** |   **31/32** |
| `nnn_nn` read as house_number        |  31/32 |    **0/32** |    **0/32** |
| `nnnn_ll` (24 NL) read as postcode   |  19/24 |   **24/24** |   **24/24** |
| `nnnn_ll` read as house_number       |   5/24 |    **0/24** |    **0/24** |

The house_number misreading is gone from all 56. This restores v5.3.0's reading.

The single residual is `SK 010 01`, which reads `O` — the one input that failed as `O` rather than
`house_number` under the control too. A leading zero is a different defect from the other 31 and was
identified as separate BEFORE the candidate was graded, which is what makes 31/32 readable as a
complete result against the targeted failure.

NL was not intact under the control either: 5 of its 24 already read as `house_number`, so "without
losing NL" meant holding 19/24. It reached 24/24.

### 2. The promotion battery — PASS, 18 of 18

`v9.0.0-base`, both artifacts, `verdict: PASS`.

`fr.bare_street_intact: 100 (floor 75)` — unchanged from v5.5.0, so the D-rule holds on the tier-1
locale this arm most risked. `mask-regression` is SKIPPED because the spec declares no
`requires_conventions`; that is a spec property, not a result.

The int8 delta cap, which failed an earlier arm where fp32 passed, is clear here: the largest
divergence across 17 compared checks is **0.3pp** (`us.street`), with 11 of 17 at exactly 0.

### 3. The target-family boards — PARTIAL

| board                               |  v5.5.0 |      v5.6.0 |
| ----------------------------------- | ------: | ----------: |
| `sg/register.jsonl`                 | 118/240 | **118/240** |
| `us/family-po-box.jsonl`            |     6/6 |     **6/6** |
| `ve/family-locality-postcode.jsonl` |     5/5 |     **3/5** |

Board-wide the arm is net positive — 522/578 → 537/578, 33 newly passing and 18 newly failing — but
**that net cannot be attributed**. 51 rows moved, and the recorded noise floor for a from-scratch arm
is 58 rows moved by a seed change alone with the corpus fixed
(`feedback-board-row-counts-are-noise-for-from-scratch-arms`). The board decides shipping; it does not
attribute.

Two of the 33 "fixes" are `cz-bare-postcode-100-00` and `cz-bare-postcode-110-00`. Both are real
OpenAddresses Czech codes, both are IN training, and neither was ever on the 56-string reserve — so
they measure that the source drew, never the capability. Flagged before the run, and #2246 proposes
the build-time refusal that would have prevented it.

## 4. The VE rows are an upstream defect, diagnosed

The two rows are `improvement_target #1821`, and both carry a trailing region:

```
Maracaibo 4001, Zulia, Venezuela   → country "null" ≠ "Venezuela"; region "null" ≠ "Zulia"
Valencia 2001, Carabobo, Venezuela → locality "Carabobo" ≠ "Valencia"; region "null" ≠ "Carabobo"
```

The board's statuses were calibrated against v5.3.0 (`1991d4a24`), which also failed these two. v5.5.0
passing them was the outlier; v5.6.0 returns to the calibration baseline.

An ablation ladder isolates the mechanism in one variable — **the postcode token is the trigger**:

| input                              | `Zulia` tagged | scope  | outcome                                                |
| ---------------------------------- | -------------- | ------ | ------------------------------------------------------ |
| `Maracaibo, Zulia, Venezuela`      | **region**     | VE     | region confirmed, country confirmed, 3 lineage vouched |
| `Maracaibo 4001, Zulia, Venezuela` | **locality**   | **CO** | country lookup 0 candidates, no country                |
| `Maracaibo 4001, Venezuela`        | —              | VE     | country confirmed                                      |
| `Zulia, Venezuela`                 | locality       | VE     | **0 candidates for locality "Zulia"**                  |

Venezuela has a REGION Zulia and no LOCALITY Zulia; Colombia has a locality Zulia. So once the parse
says "locality Zulia", Colombia is the only country that satisfies the claim, the country inference
follows the mis-tag, and `Venezuela` is then looked up inside Colombia and returns nothing. A parse
mis-tag becomes a country error because the resolver infers the country that makes the mis-tag true.

Venezuelan postcodes are absent from the gazetteer entirely — every VE postcode lookup returns 0
candidates, against a US control where `Chicago 60601, Illinois, United States` returns 1 postalcode
candidate and resolves it at rank 1. So locality-level with a 25 km tolerance is the ceiling for these
rows until that data exists, and the tolerance is a ceiling rather than slack.

## 5. Standing after this run

- The capability is present on both artifacts and attributable: the 56 strings are excluded from
  training and moved 0 → 31 of 32 and 19 → 24 of 24.
- The promotion battery passes 18 of 18 with no FR regression.
- The two VE rows fail on a diagnosed upstream cascade, not on anything this corpus changed.
- `SK 010 01` and `Praha 100 00, Czechia` remain open. The in-context CZ form still splits into
  `postcode "00"` with `cz_postcode "100 00" matched: false`, so the bare form is fixed and the
  in-context form is not.
