# Reproduction of a shipped model (worked example: v4.2.0)

The "clone + train" recipe (#480). A shipped model is reproducible from five inputs. This
page lists exactly where each lives and the commands that consume them. The worked example
is **v4.2.0** (`v1.0.2-consolidation-runB`); substitute per the eval-ledger row
(`evals/scores-by-version.json`) for any other version. A row records the code, config and corpus
version. Rows appended from 2026-10-24 also record `tokenizer_md5`, read from the model card's
`files_md5`. Earlier rows leave the tokenizer unrecorded, so read it from that release's model card.

## The five inputs

| Input               | v4.2.0 value                                                           | Where it lives                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model training code | `packages/trainer/` (the Python trainer at the release tag for v4.2.0) | this repo                                                                                                                                                                                     |
| Config              | `packages/corpus/data/training-configs/v1.0.2-consolidation-runB.yaml` | this repo                                                                                                                                                                                     |
| Corpus              | `corpus-v0.4.12-consolidation` (Parquet files + MANIFEST)              | R2 `mailwoman-assets` bucket → Modal volume `mailwoman-training` at `/data/corpus/versioned/`                                                                                                 |
| Tokenizer           | `v0.6.0-a0/tokenizer.model` (md5 `b6137e8c…`)                          | same volume, `/data/models/tokenizer/`                                                                                                                                                        |
| Aux lookups         | `pilot-anchor-lookup.json` + `anchor-lexicon-v1.json`                  | volume `/data/anchor/`, `/data/gazetteer/` — rebuildable from source: `scripts/build-pilot-anchor-lookup.ts`, `scripts/build-gazetteer-anchor-lexicon.mjs` (needs the custom WOF DBs + codex) |

> **Known gaps (the #480 gaps, still open):** the corpus + tokenizer are snapshots on
> R2/Modal rather than derivable offline from the repo (adapters fetch from live sources that age);
> overlay corpus manifests reference base corpora by absolute volume path (strict-mode
> loader is the planned guard); `init_from`/curriculum state is recorded in the model card's
> recipe text rather than yet machine-checked on resume.

## The commands

The trainer and the exporter are the Rust crates in `packages/trainer`. A release before the Python trainer's removal
(#2874) was trained by the Python trainer at its release tag. The Rust trainer reproduces that trainer's draws and
updates within the tolerances in `docs/engineering/reference/training-row-encoder.mdx`, so a retrain today matches the
recorded scores rather than the recorded bytes.

```bash
# 1. Train (Modal A100). `start` resolves the config, runs the preflight on the host copy of the volume and starts one
#    detached sandbox; `status <run key>` and `logs <run key>` follow it.
node packages/mailwoman/tools/training/launch/launch.run.ts start --config v1.0.2-consolidation-runB --fresh

# 2. Copy the checkpoint directory (config.json and the weights) from the volume to the host, then export ONNX.
#    A span-scorer checkpoint also gets semi-crf-transitions.json.
cargo run --profile trainer -p trainer-export -- \
  export-onnx --checkpoint ./step-020000 --output ./model-fp32.onnx

# 3. Quantize int8 on the host
cargo run --profile trainer -p trainer-export -- \
  quantize --input ./model-fp32.onnx --output ./model-int8.onnx

# 4. Check (one command — the check spec is the interface)
node mailwoman/out/cli.js eval check --model ./model-fp32.onnx --int8 ./model-int8.onnx --spec mailwoman/eval-harness/specs/v4.2.0-ship.json
```

Expected: `eval promote` `PASS` 12/12. The int8 md5 `9eb4a99f6db06cccff57939f657c09f9` is v4.2.0's shipped bytes under
the toolchain of its day. The Rust exporter writes a graph that computes the same logits under different bytes, so a
rebuild today differs from that md5 and is correct. Compare graphs and outputs before concluding anything from a
digest mismatch.

## The export and quantization toolchain

`trainer-export` writes opset 17 with the `value_info` annotations onnxruntime's `quantize_dynamic` produced, and its
quantizer applies onnxruntime's `MatMulInteger` and `ConvInteger` rules. Those two properties keep the int8 graph
Safari-WebGPU-safe. Its parity records against the pinned onnxruntime 1.30.0 quantizer are under
`/mnt/mw/audits/port-parity/export/`.

The browser runs the `onnxruntime-web` version `packages/neural/package.json` pins. The training image's libtorch and
Rust toolchain pins are in `packages/mailwoman/tools/training/launch/image.ts`. Two runtimes executing the same int8 bytes can disagree: 1.26.0 and 1.29.0 differed by
up to ~1e-1 on a logit with 0 argmax flips over 172 real tokens across ten addresses. A graph is validated on the runtime
version the browser serves.

## Eval procedure invariants

Gaz-trained models (v4.2.0+) are always evaluated with
`--gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json --suppress-gaz-near-postcode`
(zero-filled clues depress country recall and fake an affix crash). Never compare F1 across
tokenizer versions. Compare fp32 to fp32 for measurement. Use int8 for ship claims. Recompile
(`yarn compile`) before any eval — harnesses load `core/out`.
