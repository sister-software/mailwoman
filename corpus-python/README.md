# `mailwoman-corpus-python`

Python helpers for the Mailwoman pipeline. **Not** a Yarn workspace — has its own
`pyproject.toml` and is invoked from the host's Python environment, not from Node.

Two Python responsibilities now live here:

1. **Tokenizer training** (`scripts/train_tokenizer.py`) — Phase 1: trains a SentencePiece
   unigram model on a balanced US/FR sample of `raw` strings; writes `tokenizer.model` +
   `tokenizer.vocab` + `META.json` to `/data/models/tokenizer/v<version>/`.
2. **Model training** (`src/mailwoman_train/`, invoked via `python -m mailwoman_train …`) —
   Phase 2: end-to-end train → eval → ONNX export → int8 quantize → weights-package assembly
   for the Stage 1 coarse token-classification model.

The JSONL → Parquet conversion that lived here in Phase 1 was deleted alongside the JS-native
Parquet writer (`@dsnp/parquetjs`-based) that landed in `packages/corpus/src/parquet.ts` —
`mailwoman corpus build` now writes `.parquet` shards directly with no Python in the loop.

## Install

The base install gives you the tokenizer-training and corpus-sampling scripts:

```sh
cd packages/corpus-python
python3 -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
```

For Phase 2 model training you also need the heavy ML stack (`torch`, `transformers`,
`datasets`, `onnx`, `onnxruntime`):

```sh
pip install -e .[train]
```

The expected runtime is Python 3.10+. The `[train]` extra pulls CPU-default PyTorch wheels; if
you want CUDA, install `torch` separately from the appropriate wheel index _before_ installing
this package — pip's resolver will keep the CUDA build.

### Lab GPU (Radeon 780M / gfx1103) recipe

For the lab's specific iGPU you must use the ROCm 6.2 wheel and set the override env var:

```sh
python3 -m venv ~/training-venv
. ~/training-venv/bin/activate
pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/rocm6.2
pip install -e .[train]
export HSA_OVERRIDE_GFX_VERSION=11.0.0   # required: gfx1103 unofficially supported
```

`mailwoman_train` automatically forces math SDPA (the only attention kernel that runs
stably on this iGPU) at every CLI entry point. The `MailwomanCoarseEncoder` is hand-rolled
(no `nn.TransformerEncoderLayer`, no `BertForTokenClassification`) to avoid two known
firmware hangs in fused attention paths. See `DECISIONS.md` for the full rationale.

Empirical batch envelope on gfx1103: micro-batch ≤64 bf16 stable, ≥96 hangs.
`configs/stage1-coarse.yaml` ships with `batch_size=64`, `grad_accum_steps=2` (effective 128).

## Scripts (`scripts/`)

- `train_tokenizer.py` — SentencePiece training entrypoint (see Phase 1 docstring).
- `sample_balanced_raws.py` — Pull a balanced per-country `raw` sample from a corpus directory
  via PyArrow reservoir sampling. Used to feed `train_tokenizer.py`.

## Phase 2 training CLI (`mailwoman_train`)

```sh
# 1. Train a Stage 1 coarse model end-to-end.
python -m mailwoman_train train --config src/mailwoman_train/configs/stage1-coarse.yaml

# 2. Eval an existing checkpoint against the golden set.
python -m mailwoman_train eval \
  --config src/mailwoman_train/configs/stage1-coarse.yaml \
  --checkpoint /data/models/checkpoints/stage1-coarse/step-050000 \
  --golden-dir /path/to/data/eval/golden/v0.1.0

# 3. Export the checkpoint to ONNX with dynamic axes + verify PyTorch ↔ ONNX parity.
python -m mailwoman_train export \
  --config src/mailwoman_train/configs/stage1-coarse.yaml \
  --checkpoint /data/models/checkpoints/stage1-coarse/step-050000 \
  --output /data/models/onnx/model-v0.1.0-fp32.onnx \
  --parity-samples 1000

# 4. Int8-quantize the ONNX model.
python -m mailwoman_train quantize \
  --input /data/models/onnx/model-v0.1.0-fp32.onnx \
  --output /data/models/quantized/model-v0.1.0-int8.onnx

# 5. Assemble the neural-weights-{en-us,fr-fr} package directories.
python -m mailwoman_train package \
  --config src/mailwoman_train/configs/stage1-coarse.yaml \
  --checkpoint /data/models/checkpoints/stage1-coarse/step-050000 \
  --int8-model /data/models/quantized/model-v0.1.0-int8.onnx \
  --golden-dir /path/to/data/eval/golden/v0.1.0 \
  --steps 50000 --hardware "1× A100 / 80GB" \
  --corpus-version 0.1.0 --tokenizer-version 0.1.0
```

For wiring validation only — produces _non-production_ weights:

```sh
python -m mailwoman_train smoke \
  --config src/mailwoman_train/configs/stage1-smoke.yaml \
  --golden-dir /path/to/data/eval/golden/v0.1.0
```

The smoke command runs the entire pipeline at tiny scale on CPU (~20 seconds wall) and writes
weights packages tagged as smoke builds in their README.

## Why a separate Python package at all?

SentencePiece is a native binary dep without a maintained Node bindings story for **training**
(the JS ports are inference-only). PyTorch / Transformers are similarly Python-canonical.
Keeping the Python side standalone:

- Lets the TS pipeline build / test / ship without a Python toolchain on every CI runner.
- Cleanly factors training (slow, GPU-bound) away from the streaming corpus build (fast, JS).

See `DECISIONS.md` for the formal rationale on each call.
