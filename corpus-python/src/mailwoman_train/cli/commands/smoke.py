"""`smoke` — the whole pipeline at tiny scale on CPU: train, eval, export, quantize, package.

This validates the WIRING. It does not produce shippable weights, and every bundle it writes says
so in its card and its README.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from ..packages_root import find_packages_root
from ..smoke_mode import add_smoke_mode_flag, apply_smoke_mode

NAME = "smoke"

#: Parity samples at smoke scale. Enough to catch a graph that exports wrong, few enough to stay
#: inside a CPU run.
PARITY_SAMPLES = 32
SMOKE_LOCALES = ("en-us", "fr-fr")


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="End-to-end smoke train + eval + export + quantize + package")
    parser.add_argument("--config", default=None, help="Path to YAML config (optional)")
    parser.add_argument("--golden-dir", default=None)
    add_smoke_mode_flag(
        parser,
        help_text="LR schedule for the smoke train leg. Defaults to 'constant'.",
    )
    parser.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    import torch

    from ...config import load_config
    from ...data.loader import iter_batches
    from ...evaluation.evaluate import load_golden_dir, render_report_markdown, report_to_json, run_eval
    from ...export.onnx import export_to_onnx, verify_parity
    from ...export.package_weights import build_model_card, render_package_json, render_readme, write_package
    from ...export.quantize import quantize_dynamic_int8
    from ...nn.encoder import MailwomanCoarseEncoder
    from ...tokenizer import Tokenizer
    from ...train.trainer import train

    cfg = load_config(args.config)
    # A smoke defaults to constant LR: a cosine decay flattens the loss curve on its own, which is
    # indistinguishable from the divergence a smoke exists to catch.
    if getattr(args, "smoke_mode", None) is None:
        args.smoke_mode = "constant"
    apply_smoke_mode(args, cfg)

    started = time.time()
    train(cfg)

    checkpoints = sorted(Path(cfg.train.output_dir).glob("step-*"))
    if not checkpoints:
        sys.stderr.write("smoke: no checkpoints written\n")
        return 1
    checkpoint = checkpoints[-1]
    print(f"smoke: using checkpoint {checkpoint}")

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    model = MailwomanCoarseEncoder.from_pretrained(checkpoint)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    entries = load_golden_dir(Path(args.golden_dir or "data/eval/golden/v0.1.0"))
    report = run_eval(cfg, model, tokenizer, entries, device=device)
    (checkpoint / "eval-report.md").write_text(render_report_markdown(report, header="Smoke eval"), encoding="utf-8")
    (checkpoint / "eval-report.json").write_text(json.dumps(report_to_json(report), indent=2) + "\n", encoding="utf-8")

    run_name = Path(cfg.train.output_dir).name
    fp32_path = Path("/data/models/onnx") / f"model-{run_name}-fp32.onnx"
    export_to_onnx(model, fp32_path, max_length=cfg.data.max_length, pad_token_id=tokenizer.pad_id)

    samples = []
    for batch in iter_batches(cfg, tokenizer, split="val", batch_size=1, seed=0, row_limit=PARITY_SAMPLES):
        samples.append((batch["input_ids"][0], batch["attention_mask"][0]))
        if len(samples) >= PARITY_SAMPLES:
            break
    print(f"smoke: ONNX parity {verify_parity(model, fp32_path, samples, atol=1e-4)}")

    int8_path = Path("/data/models/quantized") / f"model-{run_name}-int8.onnx"
    quantize_dynamic_int8(fp32_path, int8_path)
    print(f"smoke: int8 → {int8_path}")

    hardware = ("cuda" if torch.cuda.is_available() else "cpu") + " (smoke)"
    elapsed = time.time() - started
    packages_root = find_packages_root()
    for locale in SMOKE_LOCALES:
        pkg_dir = packages_root / f"neural-weights-{locale}"
        card = build_model_card(
            locale=locale,
            corpus_version=Path(cfg.data.corpus_dir).name.replace("corpus-", ""),
            tokenizer_version="0.1.0",
            training_steps=cfg.train.max_steps,
            eval_report=report_to_json(report),
            notes="SMOKE BUILD — pipeline-validation only, not production weights.",
            training_hardware=hardware,
            training_duration_seconds=elapsed,
            base_path=checkpoint,
        )
        write_package(
            pkg_dir,
            int8_model_path=int8_path,
            tokenizer_model_path=Path(cfg.data.tokenizer_dir) / "tokenizer.model",
            model_card=card,
            package_json=render_package_json(locale),
            readme_md=render_readme(
                locale=locale,
                corpus_version=Path(cfg.data.corpus_dir).name,
                eval_report=report_to_json(report),
                training_steps=cfg.train.max_steps,
                training_hardware=hardware,
                smoke=True,
            ),
        )
        print(f"smoke: weights package → {pkg_dir}")

    print("smoke: OK")
    return 0
