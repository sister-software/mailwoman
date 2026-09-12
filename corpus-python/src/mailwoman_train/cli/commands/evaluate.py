"""`eval` — run the golden-set eval against a saved checkpoint and write a report.

The module is `evaluate` rather than `eval` because `from . import eval` shadows the builtin in the
registry's namespace. The subcommand a person types is unchanged.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

NAME = "eval"


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="Eval a checkpoint against the golden set")
    parser.add_argument("--config", default=None, help="Path to YAML config (optional)")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--golden-dir", default=None)
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    import torch

    from ...config import load_config
    from ...evaluation.evaluate import load_golden_dir, render_report_markdown, report_to_json, run_eval
    from ...nn.encoder import MailwomanCoarseEncoder
    from ...tokenizer import Tokenizer

    cfg = load_config(args.config)
    if args.golden_dir:
        cfg.eval.golden_dir = args.golden_dir
    if not cfg.eval.golden_dir:
        sys.stderr.write("eval.golden_dir not set; pass --golden-dir or fill it in the YAML\n")
        return 2

    ck_dir = Path(args.checkpoint)
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    entries = load_golden_dir(Path(cfg.eval.golden_dir))
    report = run_eval(cfg, model, tokenizer, entries, device=device)

    out_md = ck_dir / "eval-report.md"
    out_json = ck_dir / "eval-report.json"
    out_md.write_text(render_report_markdown(report, header=f"Eval report — {ck_dir.name}"), encoding="utf-8")
    out_json.write_text(json.dumps(report_to_json(report), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_md}")
    print(f"wrote {out_json}")
    return 0
