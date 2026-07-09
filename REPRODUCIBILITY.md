# Reproducing a shipped model (worked example: v4.2.0)

The "clone + train" recipe (#480). A shipped model is reproducible from five inputs; this
page names exactly where each lives and the commands that consume them. The worked example
is **v4.2.0** (`v1.0.2-consolidation-runB`); substitute per the eval-ledger row
(`evals/scores-by-version.json`) for any other version — every row records the same five.

## The five inputs

| Input         | v4.2.0 value                                                               | Where it lives                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Training code | `corpus-python/src/mailwoman_train/` @ the release tag                     | this repo                                                                                                                                                                                     |
| Config        | `corpus-python/src/mailwoman_train/configs/v1.0.2-consolidation-runB.yaml` | this repo                                                                                                                                                                                     |
| Corpus        | `corpus-v0.4.12-consolidation` (Parquet shards + MANIFEST)                 | R2 `mailwoman-assets` bucket → Modal volume `mailwoman-training` at `/data/corpus/versioned/`                                                                                                 |
| Tokenizer     | `v0.6.0-a0/tokenizer.model` (md5 `b6137e8c…`)                              | same volume, `/data/models/tokenizer/`                                                                                                                                                        |
| Aux lookups   | `pilot-anchor-lookup.json` + `anchor-lexicon-v1.json`                      | volume `/data/anchor/`, `/data/gazetteer/` — rebuildable from source: `scripts/build-pilot-anchor-lookup.ts`, `scripts/build-gazetteer-anchor-lexicon.mjs` (needs the custom WOF DBs + codex) |

> **Honest caveats (the #480 gaps, still open):** the corpus + tokenizer are snapshots on
> R2/Modal, not derivable offline from the repo (adapters fetch from live sources that age);
> overlay corpus manifests reference base corpora by absolute volume path (strict-mode
> loader is the planned guard); `init_from`/curriculum state is recorded in the model card's
> recipe text, not yet machine-checked on resume.

## The commands

```bash
# 1. Train (Modal A100, ~35 min for a 20k continue; ~$2-3)
modal run -d corpus-python/modal/train_remote.py --config corpus-python/src/mailwoman_train/configs/v1.0.2-consolidation-runB.yaml --resume auto

# 2. Export ONNX (on Modal — local onnxruntime can trip ShapeInferenceError on dynamo graphs)
modal run corpus-python/modal/train_remote.py::export_onnx --output-dir=/data/output-v101-runB-s42 --step=020000
modal volume get mailwoman-training output-v101-runB-s42/model.onnx ./model-fp32.onnx --force

# 3. Quantize int8 (local, PINNED toolchain — see below; verify the md5 is deterministic by running twice)
corpus-python/.venv/bin/python -m mailwoman_train.cli quantize --input ./model-fp32.onnx --output ./model-int8.onnx

# 4. Gate (one command — the gate spec is the contract)
node scripts/eval/promotion-gate.ts --model ./model-fp32.onnx --int8 ./model-int8.onnx --gate scripts/eval/gates/v4.2.0-ship.json
```

Expected: int8 md5 `9eb4a99f6db06cccff57939f657c09f9` (v4.2.0's shipped bytes), gate PASS
12/12. A different md5 with a passing gate = toolchain drift — see the verifier below
before trusting anything.

## The pinned export/quant toolchain

`torch==2.12.0 · transformers==5.9.0 · onnx==1.21.0 · onnxruntime==1.26.0 · onnxscript==0.7.0`
(the v4.1.0 set; source of truth is `corpus-python/modal/train_remote.py`'s training image).
**This set is essential**: opset ≤17 + the `value_info` strip in `quantize.py` are what
keep the int8 graph Safari-WebGPU-safe. Check your local env against it:

```bash
node scripts/verify-export-quant-versions.ts   # exits nonzero on any mismatch
```

## Eval procedure invariants

Gaz-trained models (v4.2.0+) are ALWAYS evaluated with
`--gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json --suppress-gaz-near-postcode`
(zero-filled clues depress country recall and fake an affix crash). Never compare F1 across
tokenizer versions. fp32-to-fp32 for measurement; int8 for ship claims. Recompile
(`yarn compile`) before any eval — harnesses load `core/out`.
