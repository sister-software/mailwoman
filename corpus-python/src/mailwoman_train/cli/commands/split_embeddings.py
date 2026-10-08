"""`split-embeddings` — move the token-embedding table out of an int8 ONNX model."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

NAME = "split-embeddings"


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(
        NAME, help="Write encoder.onnx plus the MWE1 embedding row files from an int8 model.onnx"
    )
    parser.add_argument("--input", required=True, help="int8 model.onnx")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--counts", help="per-piece occurrence counts (.npy, one int per vocabulary id)")
    parser.add_argument("--coverage", type=float, default=0.99, help="share of occurrences the hot subset covers")
    parser.add_argument(
        "--always",
        default="0,1,2,3",
        help="comma-separated ids every hot subset carries (the tokenizer's control pieces)",
    )
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    import numpy as np

    from ...export.split_embeddings import split_model_file

    counts = np.load(args.counts) if args.counts else None
    always = np.array([int(i) for i in args.always.split(",") if i.strip()], dtype=np.int64)
    summary = split_model_file(
        Path(args.input), Path(args.out_dir), counts=counts, coverage=args.coverage, always=always
    )
    print(json.dumps(summary, indent=2))
    return 0
