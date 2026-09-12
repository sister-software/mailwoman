"""`train` — train a Stage 1 coarse model end-to-end."""

from __future__ import annotations

import argparse
from typing import Any

from ..smoke_mode import add_smoke_mode_flag, apply_smoke_mode

NAME = "train"


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="Train a Stage 1 coarse model")
    parser.add_argument("--config", default=None, help="Path to YAML config (optional)")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--max-steps", type=int, default=None)
    parser.add_argument(
        "--resume",
        default=None,
        help='Resume from this checkpoint dir, or pass "auto" to use the latest step-* under output_dir.',
    )
    add_smoke_mode_flag(
        parser,
        help_text=(
            "Override the LR schedule for a verdict-smoke run. 'constant' = flat LR after warmup "
            "so divergence is not masked by cosine decay. 'long-tail' = keep cosine, expecting a "
            "max_steps long enough that the tail does not dominate the smoke window."
        ),
    )
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    from ...config import load_config
    from ...train.trainer import train

    cfg = load_config(args.config)
    if args.output_dir:
        cfg.train.output_dir = args.output_dir
    if args.max_steps is not None:
        cfg.train.max_steps = args.max_steps
    apply_smoke_mode(args, cfg)
    train(cfg, resume_from=args.resume)
    return 0
