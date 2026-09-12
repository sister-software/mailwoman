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
| Corpus        | `corpus-v0.4.12-consolidation` (Parquet files + MANIFEST)                  | R2 `mailwoman-assets` bucket → Modal volume `mailwoman-training` at `/data/corpus/versioned/`                                                                                                 |
| Tokenizer     | `v0.6.0-a0/tokenizer.model` (md5 `b6137e8c…`)                              | same volume, `/data/models/tokenizer/`                                                                                                                                                        |
| Aux lookups   | `pilot-anchor-lookup.json` + `anchor-lexicon-v1.json`                      | volume `/data/anchor/`, `/data/gazetteer/` — rebuildable from source: `scripts/build-pilot-anchor-lookup.ts`, `scripts/build-gazetteer-anchor-lexicon.mjs` (needs the custom WOF DBs + codex) |

> **Known gaps (the #480 gaps, still open):** the corpus + tokenizer are snapshots on
> R2/Modal, not derivable offline from the repo (adapters fetch from live sources that age);
> overlay corpus manifests reference base corpora by absolute volume path (strict-mode
> loader is the planned guard); `init_from`/curriculum state is recorded in the model card's
> recipe text, not yet machine-checked on resume.

## The commands

```bash
# 1. Train (Modal A100, ~35 min for a 20k continue; ~$2-3). The launcher is a package: run it with
#    `-m` from corpus-python/, because a file path puts `launch/` itself on sys.path and its
#    relative imports then fail.
cd corpus-python
modal run -d -m launch.train_remote --config v1.0.2-consolidation-runB.yaml --resume auto

# 2. Export ONNX (on Modal — local onnxruntime can trip ShapeInferenceError on dynamo graphs)
modal run -m launch.train_remote::export_onnx --output-dir=/data/output-v101-runB-s42 --step=020000
modal volume get mailwoman-training output-v101-runB-s42/model.onnx ./model-fp32.onnx --force

# 3. Quantize int8 (local, PINNED toolchain — see below; verify the md5 is deterministic by running twice)
corpus-python/.venv/bin/python -m mailwoman_train.cli quantize --input ./model-fp32.onnx --output ./model-int8.onnx

# 4. Check (one command — the check spec is the contract)
node mailwoman/out/cli.js eval check --model ./model-fp32.onnx --int8 ./model-int8.onnx --spec mailwoman/eval-harness/specs/v4.2.0-ship.json
```

Expected: `eval promote` PASS 12/12. The int8 md5 `9eb4a99f6db06cccff57939f657c09f9` is v4.2.0's
shipped bytes under the toolchain of its day, and the `onnxscript` 0.7.0 → 0.7.2 bump since then
changes the graph's bytes without changing what it computes — so a rebuild today differs from that
md5 and is correct. A digest is no longer the drift test on its own: read the pinned-toolchain
section below, and compare graphs and outputs before concluding anything from a mismatch.

## The pinned export/quant toolchain

`torch==2.12.0 · transformers==5.9.0 · onnx==1.22.0 · onnxruntime==1.29.0 · onnxscript==0.7.2`
(the authoritative list is `corpus-python/launch/app.py`'s training image).
**This set is essential**: opset ≤17 + the `value_info` strip in `quantize.py` are what
keep the int8 graph Safari-WebGPU-safe.

`onnxruntime` matches the `onnxruntime-web` the browser runs, and `verify_toolchain.py` refuses a
gap between them. The gap is not cosmetic: 1.26.0 and 1.29.0 executing the SAME int8 bytes disagree
by up to ~1e-1 on a logit. That changed no decision over a real-address probe — 0 argmax flips over
172 real tokens across ten addresses — but a graph validated by one runtime and served by another
is being checked by an instrument that is not the one in the user's hands.

Two of these pins moved without moving the shipped graph, and one moved it. `onnx` 1.21.0 → 1.22.0
and `onnxruntime` 1.26.0 → 1.29.0 are byte-neutral: each produces an int8 artifact identical to the
one before it, verified digest-for-digest. `onnxscript` 0.7.0 → 0.7.2 is NOT — its optimizer
constant-folds twelve shape-plumbing nodes (1 Mul, 9 Concat, 2 Reshape) into six initializers, so
fp32 grows 2,576 bytes and int8 seven, while opset, `ir_version`, inputs, outputs and every weight
tensor stay identical and both graphs answer bit-for-bit equal logits at sequence 8, 64 and 128.
**A rebuild of an artifact exported before that pin will differ in md5 and be correct.** When a
rebuild's digest does not match, compare the graphs and the outputs before concluding drift; the
md5 below is the v4.2.0 artifact's and predates the `onnxscript` bump.

Check your local env against the set:

```bash
node packages/mailwoman/lib/dev-tools/verify-export-quant-versions.run.ts   # exits nonzero on any mismatch
```

## Eval procedure invariants

Gaz-trained models (v4.2.0+) are ALWAYS evaluated with
`--gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json --suppress-gaz-near-postcode`
(zero-filled clues depress country recall and fake an affix crash). Never compare F1 across
tokenizer versions. fp32-to-fp32 for measurement; int8 for ship claims. Recompile
(`yarn compile`) before any eval — harnesses load `core/out`.
