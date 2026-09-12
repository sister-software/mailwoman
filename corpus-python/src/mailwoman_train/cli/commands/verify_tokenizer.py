"""`verify-tokenizer` — re-tokenize a sample of corpus rows and assert the encoder works."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

NAME = "verify-tokenizer"


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="Re-tokenize a sample of corpus rows and assert OK")
    parser.add_argument("--config", default=None, help="Path to YAML config (optional)")
    parser.add_argument("--sample", type=int, default=100)
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    from ...config import load_config
    from ...data.loader import verify_tokenizer_alignment
    from ...tokenizer import Tokenizer

    cfg = load_config(args.config)
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    verify_tokenizer_alignment(Path(cfg.data.corpus_dir), tokenizer, sample_size=args.sample)
    print(f"verified {args.sample} rows against {cfg.data.tokenizer_dir}")
    return 0
