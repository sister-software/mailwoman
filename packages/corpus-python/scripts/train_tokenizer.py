#!/usr/bin/env python3
"""Train the SentencePiece tokenizer that locks to a corpus version.

Per the Phase 1 plan:

* Input is a sample of `raw` strings drawn from the coarse adapters
  (wof-admin, wof-postalcode, osm-places) — balanced across US + FR. 5M
  lines is the upper bound; the script accepts whatever lines you feed
  it on stdin or via --input.
* Trains SentencePiece with:
    - vocab_size=16000
    - character_coverage=0.9995
    - model_type=unigram
    - byte_fallback=true
* Output is `<output_dir>/tokenizer.model` + `tokenizer.vocab`. The
  convention is `/data/models/tokenizer/v<version>/`; the script also
  writes a `META.json` capturing the source line count + git commit
  + a sha256 of the model file.

The tokenizer version is locked to the corpus version: `corpus-v0.1.0`
ships with `tokenizer-v0.1.0`. Don't retrain mid-corpus — token spans
shift and BIO labels become wrong (this script does not enforce that;
the operator must.

## Usage

Drop a balanced JSONL sample into a file (5M lines max):

    jq -r '.raw' /data/corpus/versioned/corpus-v0.1.0/intermediate/labeled.jsonl \
      | head -5000000 \
      > /tmp/raws.txt

    python train_tokenizer.py \
      --input /tmp/raws.txt \
      --output /data/models/tokenizer/v0.1.0/ \
      --version 0.1.0

Or pipe lines via stdin:

    cat /tmp/raws.txt | python train_tokenizer.py \
      --output /data/models/tokenizer/v0.1.0/ \
      --version 0.1.0

## Locale balancing

The script is **not** itself locale-aware — it trains on whatever raw
strings you hand it. To get balanced US/FR coverage, pre-sample upstream:

    (jq -r 'select(.country == "US") | .raw' .../labeled.jsonl | shuf -n 2500000;
     jq -r 'select(.country == "FR") | .raw' .../labeled.jsonl | shuf -n 2500000) \
      | shuf > /tmp/raws.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable

try:
    import sentencepiece as spm
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "missing sentencepiece — install via `pip install -e .[dev]` from packages/corpus-python\n"
    )
    raise SystemExit(2) from exc


VOCAB_SIZE = 16000
CHARACTER_COVERAGE = 0.9995
MODEL_TYPE = "unigram"
BYTE_FALLBACK = True


def iter_lines(source: Path | None) -> Iterable[str]:
    """Yield non-empty lines from a file path, or stdin if source is None."""
    if source is None:
        for line in sys.stdin:
            line = line.rstrip("\n")
            if line:
                yield line
        return
    with source.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line:
                yield line


def git_commit() -> str | None:
    """Best-effort: return the current HEAD SHA, or None if not a git checkout."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=Path(__file__).parent, stderr=subprocess.DEVNULL
        )
        return out.decode("utf-8").strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def train(input_path: Path, output_dir: Path, version: str) -> dict:
    """Train SentencePiece and persist the model + META.json."""
    output_dir.mkdir(parents=True, exist_ok=True)
    model_prefix = output_dir / "tokenizer"

    # SentencePiece's trainer is one big native call; it streams the input file
    # internally so we don't need to load it.
    spm.SentencePieceTrainer.train(
        input=str(input_path),
        model_prefix=str(model_prefix),
        vocab_size=VOCAB_SIZE,
        character_coverage=CHARACTER_COVERAGE,
        model_type=MODEL_TYPE,
        byte_fallback=BYTE_FALLBACK,
        # Pad / unk / bos / eos are reserved at the small ids; the rest is unigram.
        pad_id=0,
        unk_id=1,
        bos_id=2,
        eos_id=3,
        # Reserve a generous user_defined symbol pool for BIO labels' surface forms
        # if a future iteration wants them as atoms; harmless if unused.
        user_defined_symbols=[],
    )

    model_path = model_prefix.with_suffix(".model")
    vocab_path = model_prefix.with_suffix(".vocab")

    line_count = sum(1 for _ in input_path.open("r", encoding="utf-8"))

    meta = {
        "tokenizer_version": version,
        "vocab_size": VOCAB_SIZE,
        "character_coverage": CHARACTER_COVERAGE,
        "model_type": MODEL_TYPE,
        "byte_fallback": BYTE_FALLBACK,
        "training_lines": line_count,
        "git_commit": git_commit(),
        "model_sha256": sha256(model_path),
        "model_path": str(model_path),
        "vocab_path": str(vocab_path),
    }

    (output_dir / "META.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Path to a UTF-8 text file with one raw address per line. Omit to read stdin.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output directory; tokenizer.model + tokenizer.vocab + META.json land here.",
    )
    parser.add_argument(
        "--version",
        type=str,
        required=True,
        help="Tokenizer version (e.g. '0.1.0'). MUST match the corpus version it ships with.",
    )
    args = parser.parse_args()

    source = args.input
    if source is None:
        # SentencePiece's trainer takes a file path; if reading stdin, materialize.
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tmp:
            tmp_path = Path(tmp.name)
            for line in iter_lines(None):
                tmp.write(line + "\n")
        source = tmp_path

    meta = train(source, args.output, args.version)
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
