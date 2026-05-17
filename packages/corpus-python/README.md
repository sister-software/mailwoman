# `mailwoman-corpus-python`

Python helpers for the Mailwoman corpus pipeline. **Not** a Yarn workspace — has its own
`pyproject.toml` and is invoked from the host's Python environment, not from Node.

The pipeline's TypeScript side (`@mailwoman/corpus`) emits intermediate JSONL; this package
covers the two pieces of the pipeline that need first-class Python tooling:

1. **Tokenizer training** (`scripts/train_tokenizer.py`) — trains a SentencePiece unigram model
   on a balanced US/FR sample of `raw` strings and writes `tokenizer.model` + `tokenizer.vocab`
   to a versioned directory under `/data/models/tokenizer/<version>/`.
2. **Parquet conversion** (`scripts/jsonl_to_parquet.py`) — converts the runner's intermediate
   JSONL shards to the final Parquet layout under `/data/corpus/versioned/<version>/` using
   PyArrow. Used when `@dsnp/parquetjs` proves limiting (large list columns, schema overhead).

## Install

```sh
cd packages/corpus-python
python3 -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
```

The expected runtime is Python 3.10+. SentencePiece's wheel covers Linux/macOS/Windows on
common Python versions; PyArrow ships pre-built binaries.

## Why not unify the build under Yarn?

SentencePiece and PyArrow are native binary deps that don't have first-class Node bindings of
comparable quality. Keeping the Python side standalone:

- Lets the TS pipeline build/test/ship without a Python toolchain on every CI runner.
- Avoids subprocess shelling-out across the language boundary mid-pipeline (each step writes
  to disk; the next step reads).
- Makes it trivial to swap PyArrow for a remote training runner (e.g. SageMaker, Modal) later.

See `DECISIONS.md` for the formal rationale.
