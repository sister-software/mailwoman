"""`export` — export a checkpoint to ONNX with dynamic axes, then verify parity against torch."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

NAME = "export"


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="Export a checkpoint to ONNX")
    parser.add_argument("--config", default=None, help="Path to YAML config (optional)")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--parity-samples", type=int, default=1000)
    parser.add_argument("--tolerance", type=float, default=1e-4)
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    from ...config import load_config
    from ...data.loader import iter_batches
    from ...export.onnx import export_to_onnx, verify_parity
    from ...nn.encoder import MailwomanCoarseEncoder
    from ...tokenizer import Tokenizer

    cfg = load_config(args.config)
    ck_dir = Path(args.checkpoint)
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    out = Path(args.output)

    if getattr(cfg.data, "char_mode", "off") == "char":
        return _export_char(args, cfg, model, out)

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    export_to_onnx(model, out, opset=args.opset, max_length=cfg.data.max_length, pad_token_id=tokenizer.pad_id)

    samples: list[tuple[list[int], list[int]]] = []
    for batch in iter_batches(cfg, tokenizer, split="val", batch_size=1, seed=0, row_limit=args.parity_samples):
        samples.append((batch["input_ids"][0], batch["attention_mask"][0]))
        if len(samples) >= args.parity_samples:
            break
    if not samples:
        sys.stderr.write("warning: no val rows available for parity check\n")
    metrics = verify_parity(model, out, samples, atol=args.tolerance)
    print(json.dumps({"output": str(out), **metrics}, indent=2))
    return 0


def _export_char(args: argparse.Namespace, cfg: Any, model: Any, out: Path) -> int:
    """The char path has no SentencePiece tokenizer.

    The graph takes `char_ids (B, S, W)` where S is the config's `max_units` and W its
    `max_unit_width`, and the parity sample is real val rows encoded the way training encoded them.
    """
    from ...data.loader import iter_batches
    from ...export.onnx import export_to_onnx, verify_char_parity

    if cfg.data.max_units is None or cfg.data.max_unit_width is None:
        sys.stderr.write("char_mode: char needs data.max_units and data.max_unit_width to export\n")
        return 2

    export_to_onnx(
        model,
        out,
        opset=args.opset,
        max_length=cfg.data.max_units,
        pad_token_id=0,
        char_window=cfg.data.max_unit_width,
    )
    samples: list[tuple[list[list[int]], list[int]]] = []
    for batch in iter_batches(cfg, None, split="val", batch_size=1, seed=0, row_limit=args.parity_samples):
        samples.append((batch["char_ids"][0], batch["attention_mask"][0]))
        if len(samples) >= args.parity_samples:
            break
    if not samples:
        sys.stderr.write("warning: no val rows available for parity check\n")
    metrics = verify_char_parity(model, out, samples, atol=args.tolerance)
    print(json.dumps({"output": str(out), "encoder": "char", **metrics}, indent=2))
    return 0
