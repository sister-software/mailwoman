# Confidence calibration (task #59, #240 PR3)

Post-hoc isotonic calibration of the neural decoder's per-span softmax confidence — the `conf=` a
resolver or human reads off a parse. A CE-trained model's softmax is not a calibrated probability;
this maps it to one (Expected Calibration Error 0.067 → 0.004 on the held-out eval; see
[`../../../docs/articles/evals/2026-06-07-isotonic-calibration.md`](../../../docs/articles/evals/2026-06-07-isotonic-calibration.md)).

## The pipeline

```bash
# 1. Build the 50/50 OpenAddresses + training-corpus calibration set (needs the corpus parquet).
python3 scripts/eval/build-calibration-set.py \
  --corpus /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.0/corpus-v0.4.0/train/part-0000.parquet \
  --out data/eval/calibration/calibration-set.jsonl

# 2. Run the SHIPPED model over the set → (raw span confidence, correct?) pairs.
node --experimental-strip-types scripts/eval/collect-span-confidences.ts \
  --set data/eval/calibration/calibration-set.jsonl \
  --out data/eval/calibration/confidences.jsonl

# 3. Fit isotonic (PAVA), emit the 20-bin lookup table + ECE report.
python3 scripts/eval/fit-isotonic-calibration.py
```

## What's committed vs regenerated

| File                         | Committed?      | Why                                                                                                                |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `calibration-set.jsonl`      | ✅              | Frozen fit input (the corpus parquet lives on `/mnt/playpen`, not in git) — makes the fit reproducible without it. |
| `isotonic-en-us-v4.0.0.json` | ✅              | The deliverable: the 20-bin lookup table the decoder calibrator loads.                                             |
| `confidences.jsonl`          | ❌ (gitignored) | Purely derivable from the set + the model (stage 2). 3 MB.                                                         |

## Using the table

The table is OPT-IN — the default decode path is byte-stable. Build a calibrator and pass it via
`ParseOpts.calibrate` (neural) / `BuildTreeOpts.calibrate` (decoder):

```ts
import { createCalibrator } from "@mailwoman/core/decoder"
import table from "../data/eval/calibration/isotonic-en-us-v4.0.0.json" assert { type: "json" }

const calibrate = createCalibrator(table)
const tree = await classifier.parse(input, { calibrate }) // conf= is now calibrated
```

Follow-up (not done here): promote the table into the `@mailwoman/neural-weights-en-us` package so it
ships with the model, and add a sibling table per locale as multi-locale models land.
