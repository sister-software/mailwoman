# Coarse-placer off-map breadth — OpenAddresses pull: breadth helps, threshold is the lever (2026-06-14)

_The #244 follow-up to night-15's Latin-off-map finding (trained off-map countries went 23%→100% handled
but didn't generalize to unseen ones — attributed to Overture's ALPHA theme carrying only ~7 off-map
countries). We pulled raw OpenAddresses for far broader coverage and re-ran the generalization probe with
DeepSeek's refinements (leave-one-language-family-out + an abstention-threshold sweep)._

## Setup

- **Data:** OpenAddresses europe+asia collected zips (4.5 GB) → **27 off-map countries** extracted, assembled
  to the in-map address format via DuckDB `read_csv_auto` (`union_by_name` for per-source schema variance),
  deduped, capped at 6 K rows/country (`scripts/coarse-placer/build-outlier-oa.mjs`).
- **Split — leave-one-language-FAMILY-out** (not random, per DeepSeek): **16 TRAIN** countries across 7
  families (slavic, romance, germanic, nordic, hellenic, central-asian, maritime) feed the `OTHER` class;
  **11 HELDOUT** countries across 3 families **never trained** (baltic EE/LV/LT, oceania AU/NZ/NC,
  middle-east AE/IL/KW/QA/SA) are the honest generalization probe.
- **Models:** M3 baseline (Overture, 4 off-map countries) vs the OA-broadened retrain, both evaluated on
  the same OA test set. Coarse-placer is a char-ngram hashed **linear** classifier.

## Result — breadth works for trained families, partially generalizes, and the threshold carries the rest

At the default decision threshold (abstain 0.5):

| group | M3 baseline | OA retrain | Δ |
| ----- | ----------: | ---------: | --: |
| **indist** (trained families) | 35.9% | **100.0%** | +64.1pp |
| **heldout** (never-trained families) | 53.1% | **66.1%** | **+13.0pp** |
| overall | 50.9% | 70.4% | +19.5pp |

- **Trained families → 100%**: broad real off-map exposure makes the trained families perfectly handled —
  the night-15 mechanism, now at 16-family scale.
- **Heldout +13pp**: breadth **does** generalize to unseen families, partially. But it **plateaus well below
  the 90% target** (66.1%) — exactly DeepSeek's pre-registered call: a linear char-ngram model learns
  per-country n-gram fingerprints, so more families lift the boundary only so far. **Breadth is necessary
  but insufficient.**

## The abstention threshold is the real lever (DeepSeek-confirmed)

Sweeping the threshold on the OA retrain trades in-map accuracy for off-map handling — a clean Pareto curve:

| abstain | in-map accuracy | off-map heldout handled |
| ------: | --------------: | ----------------------: |
| 0.50 | 95.1% | 66.1% |
| 0.85 | 91.8% | 82.5% |
| 0.95 | 87.8% | 87.6% |

The OA-retrained model **dominates** the M3 baseline at every threshold. ~**0.85** is a balanced operating
point: in-map stays **>90%** (91.8%) while off-map heldout jumps to **82.5%** (+29pp over M3-at-0.5). At
0.95 the two cross at ~**88/88**. Neither point hits **90/90 simultaneously** — so breadth + a tuned
threshold gets *close* but not all the way.

## Verdict

- **Breadth was worth pulling.** The OA retrain is a strict Pareto improvement (trained families →100%,
  unseen +13pp at every threshold, in-map held). The 27-country / 10-family leave-one-out probe is a far
  honester generalization signal than night-15's 7 countries.
- **But breadth alone doesn't clear the bar** — confirming DeepSeek's pushback. The final lever is **method,
  not more data**: an open-set / novelty detector (Mahalanobis on the in-map manifold, or an explicit
  "not-any-of-the-11" head) to push heldout toward 100% without the in-map cost the raw threshold imposes.
- **Shippable now (operator's call):** the OA-broadened model + a tuned threshold (~0.85) is a real,
  Pareto-dominant upgrade over M3 — ship it as the coarse-placer's new default, with the open-set method as
  the next milestone. (Not promoted here; PR-and-flag.)

## Reproduce

```bash
# data: OA europe+asia → extract off-map countries → build OTHER (leave-one-family-out)
node scripts/coarse-placer/build-dataset.mjs
node scripts/coarse-placer/build-outlier-exposure.mjs
node scripts/coarse-placer/build-outlier-oa.mjs --oa-dir <extracted> --per-country 6000
node scripts/coarse-placer/train.mjs
# verdict: heldout handled-rate before/after + threshold sweep + in-map cost
node scripts/coarse-placer/eval-latin-offmap.mjs --model <model> --abstain {0.5,0.85,0.95}
node scripts/coarse-placer/eval.mjs            --model <model> --abstain {0.5,0.85,0.95}
```

Caveats: char-ngram linear model (the boundary ceiling is the point); OA middle-east rows are
romanized/non-Latin (a script-handled subset); the threshold's in-map cost is real — the 90/90 target wants
the open-set method, tracked as the next #244 step.
