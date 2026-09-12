"""`quantize` — int8 dynamic quantization of an ONNX model."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

NAME = "quantize"


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="Int8 dynamic quantization of an ONNX model")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    from ...export.quantize import quantize_dynamic_int8

    out = quantize_dynamic_int8(Path(args.input), Path(args.output))
    print(json.dumps({"output": str(out)}, indent=2))
    return 0
