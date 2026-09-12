"""`package` — assemble the `neural-weights-<locale>/` bundles from a checkpoint and an int8 model.

A fresh eval runs here rather than reading a saved report, so the model card's numbers always
describe the int8 weights the bundle ships.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from ..packages_root import find_packages_root

NAME = "package"

#: Written into the card when no golden set is available, so a reader can tell an unmeasured
#: bundle from one that scored zero.
NO_EVAL_REPORT: dict[str, Any] = {
    "n_entries": 0,
    "full_parse_exact_match": 0.0,
    "mean_token_confidence": 0.0,  # nosec B105 — numeric eval default, not a credential
    "per_component": {},
    "calibration": [],
    "note": "no golden_dir provided; eval skipped",
}


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="Assemble neural-weights-* packages")
    parser.add_argument("--config", default=None, help="Path to YAML config (optional)")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--int8-model", required=True)
    parser.add_argument(
        "--packages-root",
        default=None,
        help="Defaults to the packages/ directory of the checkout this file lives in.",
    )
    parser.add_argument("--locales", default="en-us,fr-fr")
    parser.add_argument("--corpus-version", default="0.1.0")
    parser.add_argument("--tokenizer-version", default="0.1.0")
    parser.add_argument("--package-version", default="0.1.0", help="Version stamp for model-card.json + package.json")
    parser.add_argument("--steps", type=int, default=0)
    parser.add_argument("--hardware", default="")
    parser.add_argument("--training-duration-seconds", type=float, default=0.0)
    parser.add_argument("--notes", default="")
    parser.add_argument("--golden-dir", default=None)
    parser.add_argument("--smoke", action="store_true")
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    from ...config import load_config
    from ...evaluation.evaluate import load_golden_dir, report_to_json, run_eval
    from ...export.package_weights import build_model_card, render_package_json, render_readme, write_package
    from ...nn.encoder import MailwomanCoarseEncoder
    from ...tokenizer import Tokenizer

    cfg = load_config(args.config)

    ck_dir = Path(args.checkpoint)
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)

    eval_report_dict: dict[str, Any]
    if args.golden_dir or cfg.eval.golden_dir:
        entries = load_golden_dir(Path(args.golden_dir or cfg.eval.golden_dir))
        eval_report_dict = report_to_json(run_eval(cfg, model, tokenizer, entries))
    else:
        eval_report_dict = dict(NO_EVAL_REPORT)

    int8_path = Path(args.int8_model)
    tokenizer_model_path = Path(cfg.data.tokenizer_dir) / "tokenizer.model"
    pkg_root = Path(args.packages_root) if args.packages_root else find_packages_root()
    locales = [locale.strip() for locale in args.locales.split(",") if locale.strip()]
    for locale in locales:
        pkg_dir = pkg_root / f"neural-weights-{locale}"
        card = build_model_card(
            locale=locale,
            corpus_version=args.corpus_version,
            tokenizer_version=args.tokenizer_version,
            training_steps=args.steps,
            eval_report=eval_report_dict,
            notes=args.notes,
            training_hardware=args.hardware,
            training_duration_seconds=args.training_duration_seconds,
            base_path=ck_dir,
            package_version=args.package_version,
        )
        write_package(
            pkg_dir,
            int8_model_path=int8_path,
            tokenizer_model_path=tokenizer_model_path,
            model_card=card,
            package_json=render_package_json(locale, package_version=args.package_version),
            readme_md=render_readme(
                locale=locale,
                corpus_version=args.corpus_version,
                eval_report=eval_report_dict,
                training_steps=args.steps,
                training_hardware=args.hardware,
                smoke=args.smoke,
            ),
        )
        print(f"wrote weights package → {pkg_dir}")
    return 0
