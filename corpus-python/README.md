# `mailwoman-corpus-python`

Python helpers for the Mailwoman pipeline. This directory is not a Yarn workspace. It has its own
`pyproject.toml` and runs under `uv` (Python 3.12, pinned by `.python-version`) instead of from
Node.

All the code is in one package, `src/mailwoman_train/`, with one directory per role:

- **`cli/commands/`** holds one module per subcommand of `python -m mailwoman_train`. The
  subcommands cover training, eval, ONNX export, int8 quantization and weights-package assembly.
- **`countries/<code>/`** holds code that only one country uses. A country with its own corpus
  builder and label set is listed in `countries.COUNTRY_MODULES`. A country that only contributes
  source readers is listed in `SOURCE_ONLY`.
- **`corpora/`, `data/`, `text/`, `tokenizer/`, `features/`, `nn/`, `optim/`, `train/`,
  `evaluation/`, `export/`, `audits/`, `calibration/`, `observability/`** hold the code that all
  countries share.

A module with an `if __name__ == "__main__"` block runs as `python -m mailwoman_train.<path>`. Its
docstring gives the command, and `test_builder_entry_points` checks that the command refers to the
module that contains it.

`launch/` is the second package. It holds the Modal launcher, one module per role, and
`launch/AGENTS.md` is its runbook. Run it with `-m` from this directory
(`modal run -m launch.train_remote::<name>`). Running it by file path puts `launch/` itself on
`sys.path`, and the package's relative imports then fail. The docstring of
`launch/train_remote.py` lists what each module owns.

Phase 1 had a JSONL-to-Parquet conversion here. It was deleted when the JS-native Parquet writer
(based on `@dsnp/parquetjs`) landed in `packages/corpus/lib/parquet.ts`. `mailwoman corpus build`
now writes the `.parquet` files directly without Python.

## Install

Everything runs under [`uv`](https://docs.astral.sh/uv/). `.python-version` pins the interpreter
to 3.12, which matches the image in `launch/app.py`. Call every tool through `uv run` so that it
uses the project environment instead of a system install.

```sh
cd corpus-python
uv sync --extra dev        # base deps + dev toolchain (ruff, mypy, bandit, pytest)
uv run python -m mailwoman_train --help
```

For Phase 2 model training you also need the heavy ML stack (`torch`, `transformers`,
`datasets`, `onnx`, `onnxruntime`):

```sh
uv sync --extra train
```

The `[train]` extra installs CPU PyTorch wheels by default. For CUDA, install `torch` from the
appropriate wheel index _before_ syncing, and uv's resolver keeps the CUDA build. The Lab GPU
recipe below follows this pattern.

## Toolchain

All tools come from the `[dev]` extra. Invoke them with `uv run` so they read the project
environment and the `pyproject.toml` config:

- **Ruff** (`uv run ruff`) lints and formats. It is the Python counterpart of the repo's `oxlint`
  and `oxfmt`. Config: `[tool.ruff]`.
- **mypy** (`uv run mypy`) runs `--strict` type checking over `src/` and currently reports zero
  errors. It does not check `launch/`, because `launch/` imports the Modal SDK, which is installed
  only where `modal run` runs. Config: `[tool.mypy]`.
- **bandit** (`uv run bandit -r src`) runs security and static analysis. Config: `[tool.bandit]`.
- **pytest** (`uv run pytest`) runs the corpus test suite.

```sh
uv run ruff check .            # lint        (oxlint)
uv run ruff check --fix .      # lint + fix  (oxlint --fix)
uv run ruff format .           # format      (oxfmt)
uv run ruff format --check .   # format check, for CI
uv run mypy                    # type check  (tsc --strict)
uv run bandit -c pyproject.toml -r src   # security (static scan)
uv run pytest                  # tests       (vitest)
uv run python scripts/verify_toolchain.py   # train-pin consistency guard
```

`yarn lint` from the repo root runs the full Python check (see `.github/workflows/test.yml`). It
runs ruff lint and format, the `verify_toolchain.py` pin check, `mypy --strict` and `bandit`. Each
step goes through `uv run`, which syncs the corpus-python venv on demand. The sync includes the
`[train]` extras that mypy needs to resolve torch.

### Lab GPU (Radeon 780M / gfx1103) recipe

The lab's iGPU requires the ROCm 6.2 wheel and an override environment variable:

```sh
uv venv ~/training-venv
. ~/training-venv/bin/activate
uv pip install --upgrade pip
uv pip install torch --index-url https://download.pytorch.org/whl/rocm6.2
uv pip install -e .[train]
export HSA_OVERRIDE_GFX_VERSION=11.0.0   # required: gfx1103 unofficially supported
```

`mailwoman_train` forces math SDPA at every CLI entry point, because math SDPA is the only
attention kernel that runs stably on this iGPU. The `MailwomanCoarseEncoder` is hand-written
instead of using `nn.TransformerEncoderLayer` or `BertForTokenClassification`. This avoids two
known firmware hangs in fused attention paths. `DECISIONS.md` gives the full rationale.

On gfx1103, bf16 training ran stably at micro-batch sizes up to 64 and hung at 96 and above.
`configs/stage1-coarse.yaml` ships with `batch_size=64` and `grad_accum_steps=2` (effective 128).

## `scripts/`

This directory holds one Python file, kept outside the package on purpose. `verify_toolchain.py`
imports only the standard library, and the pre-commit hook and `package.json` invoke it as bare
`python3`. Moving it into the package would make every commit depend on a synced virtual
environment.

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

The `smoke` command checks the wiring only and produces _non-production_ weights:

```sh
python -m mailwoman_train smoke \
  --config src/mailwoman_train/configs/stage1-smoke.yaml \
  --golden-dir /path/to/data/eval/golden/v0.1.0
```

The smoke command runs the entire pipeline at tiny scale on CPU (~20 seconds wall) and writes
weights packages tagged as smoke builds in their README.

## Why a separate Python package at all?

SentencePiece is a native binary dependency without maintained Node bindings for **training**. The
JS ports support inference only. PyTorch and Transformers are also primarily Python libraries.
Keeping the Python side standalone has two effects:

- The TS pipeline can build, test and ship without a Python toolchain on every CI runner.
- Training (slow, GPU-bound) stays separate from the streaming corpus build (fast, JS).

`DECISIONS.md` gives the formal rationale for each decision.
