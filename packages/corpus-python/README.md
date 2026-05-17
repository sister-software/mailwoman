# `mailwoman-corpus-python`

Python helpers for the Mailwoman corpus pipeline. **Not** a Yarn workspace — has its own
`pyproject.toml` and is invoked from the host's Python environment, not from Node.

As of Phase 1.5 (#18 §4), the only Python step in the pipeline is **tokenizer training**:

1. **Tokenizer training** (`scripts/train_tokenizer.py`) — trains a SentencePiece unigram model
   on a balanced US/FR sample of `raw` strings and writes `tokenizer.model` + `tokenizer.vocab`
   to a versioned directory under `/data/models/tokenizer/<version>/`.

The JSONL → Parquet conversion that lived here in Phase 1 was deleted alongside the JS-native
Parquet writer (`@dsnp/parquetjs`-based) that landed in `packages/corpus/src/parquet.ts` —
`mailwoman corpus build` now writes `.parquet` shards directly with no Python in the loop.

## Install

```sh
cd packages/corpus-python
python3 -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
```

The expected runtime is Python 3.10+. SentencePiece's wheel covers Linux/macOS/Windows on
common Python versions.

## Why a separate Python package at all?

SentencePiece is a native binary dep without a maintained Node bindings story for **training**
(the JS ports are inference-only). Keeping the Python side standalone:

- Lets the TS pipeline build / test / ship without a Python toolchain on every CI runner.
- Cleanly factors the one-shot training step away from the streaming corpus build.

See `DECISIONS.md` for the formal rationale on each call.
