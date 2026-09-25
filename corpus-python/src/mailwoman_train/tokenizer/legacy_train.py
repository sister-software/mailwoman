#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess  # nosec B404
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

try:
    import sentencepiece as spm
except ImportError as exc:
    sys.stderr.write("missing sentencepiece — install via `pip install -e .[dev]` from packages/corpus-python\n")
    raise SystemExit(2) from exc


VOCAB_SIZE = 16000
CHARACTER_COVERAGE = 0.9995
MODEL_TYPE = "unigram"
BYTE_FALLBACK = True


def iter_lines(source: Path | None) -> Iterable[str]:
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
    try:
        out = subprocess.check_output(  # nosec B603, B607
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


def train(input_path: Path, output_dir: Path, version: str) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    model_prefix = output_dir / "tokenizer"

    spm.SentencePieceTrainer.train(
        input=str(input_path),
        model_prefix=str(model_prefix),
        vocab_size=VOCAB_SIZE,
        character_coverage=CHARACTER_COVERAGE,
        model_type=MODEL_TYPE,
        byte_fallback=BYTE_FALLBACK,
        pad_id=0,
        unk_id=1,
        bos_id=2,
        eos_id=3,
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
