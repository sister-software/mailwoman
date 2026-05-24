"""Subcommand CLI for ``python -m mailwoman_train``.

Subcommands:

- ``train`` — train a Stage 1 coarse model end-to-end.
- ``eval`` — run golden-set eval against a saved checkpoint; writes a markdown report.
- ``export`` — export a checkpoint to ONNX with dynamic axes + verify parity.
- ``quantize`` — int8-quantize an ONNX model.
- ``package`` — assemble ``packages/neural-weights-{en-us,fr-fr}/`` from artifacts.
- ``smoke`` — run the entire pipeline at tiny scale on CPU. Validates the wiring; does
  NOT produce shippable weights.
- ``verify-tokenizer`` — re-tokenize a sample of corpus rows and assert the SP encoder works.
- ``tokenizer`` — train a versioned SentencePiece tokenizer from a corpus shard tree, with
  byte-fallback measurement + model card. v0.5.0 Thread A harness.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from dataclasses import asdict
from pathlib import Path


def _find_packages_root() -> Path:
    """Find the workspace ``packages/`` directory by walking up from this file.

    ``cli.py`` lives at ``<repo>/packages/corpus-python/src/mailwoman_train/cli.py`` —
    five ``parent`` hops reach the repo root, then we append ``packages``.
    """
    here = Path(__file__).resolve()
    repo_root = here.parent.parent.parent.parent.parent
    pkgs = repo_root / "packages"
    if pkgs.is_dir():
        return pkgs
    return Path("packages")


def cmd_train(args: argparse.Namespace) -> int:
    from .config import load_config
    from .train import train

    cfg = load_config(args.config)
    if args.output_dir:
        cfg.train.output_dir = args.output_dir
    if args.max_steps is not None:
        cfg.train.max_steps = args.max_steps
    _apply_smoke_mode(args, cfg)
    train(cfg, resume_from=args.resume)
    return 0


def _apply_smoke_mode(args: argparse.Namespace, cfg) -> None:
    """Translate the operator-facing ``--smoke-mode`` flag into ``cfg.train.lr_schedule``.

    Lives here (not in config.py) because the policy is CLI-shaped: ``constant`` overrides
    any config schedule, ``long-tail`` is a no-op modifier (cosine stays, just warn if
    ``max_steps`` is short enough for the cosine tail to dominate the visible window).
    See docs/articles/plan/reference/VERDICT_SMOKES.md for the rationale.
    """
    mode = getattr(args, "smoke_mode", None)
    if mode is None:
        return
    if mode == "constant":
        cfg.train.lr_schedule = "constant"
        return
    if mode == "long-tail":
        # Cosine schedule, but the recipe must have a long enough max_steps that the
        # cosine tail doesn't dominate the smoke-visible portion. The threshold is
        # advisory — the operator may know what they're doing — so warn, don't error.
        if cfg.train.max_steps < 10000:
            sys.stderr.write(
                f"warning: --smoke-mode long-tail expects max_steps>=10000; got "
                f"{cfg.train.max_steps}. Cosine tail may mask divergence. See "
                "docs/articles/plan/reference/VERDICT_SMOKES.md.\n"
            )
        return
    raise ValueError(f"unknown --smoke-mode={mode!r}")


def cmd_eval(args: argparse.Namespace) -> int:
    import torch
    from .model import MailwomanCoarseEncoder

    from .config import load_config
    from .eval import (
        load_golden_dir,
        render_report_markdown,
        report_to_json,
        run_eval,
    )
    from .tokenizer import Tokenizer

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
    out_md.write_text(
        render_report_markdown(report, header=f"Eval report — {ck_dir.name}"),
        encoding="utf-8",
    )
    out_json.write_text(json.dumps(report_to_json(report), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_md}")
    print(f"wrote {out_json}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    import torch
    from .model import MailwomanCoarseEncoder

    from .config import load_config
    from .data_loader import iter_batches
    from .export_onnx import export_to_onnx, verify_parity
    from .tokenizer import Tokenizer

    cfg = load_config(args.config)
    ck_dir = Path(args.checkpoint)
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)

    out = Path(args.output)
    export_to_onnx(
        model,
        out,
        opset=args.opset,
        max_length=cfg.data.max_length,
        pad_token_id=tokenizer.pad_id,
    )

    # Build a parity sample of up to `args.parity_samples` real val-set inputs.
    samples: list[tuple[list[int], list[int]]] = []
    remaining = args.parity_samples
    for batch in iter_batches(
        cfg, tokenizer, split="val", batch_size=1, seed=0, row_limit=args.parity_samples
    ):
        samples.append((batch["input_ids"][0], batch["attention_mask"][0]))
        remaining -= 1
        if remaining <= 0:
            break
    if not samples:
        sys.stderr.write("warning: no val rows available for parity check\n")
    metrics = verify_parity(model, out, samples, atol=args.tolerance)
    print(json.dumps({"output": str(out), **metrics}, indent=2))
    return 0


def cmd_quantize(args: argparse.Namespace) -> int:
    from .quantize import quantize_dynamic_int8

    out = quantize_dynamic_int8(Path(args.input), Path(args.output))
    print(json.dumps({"output": str(out)}, indent=2))
    return 0


def cmd_package(args: argparse.Namespace) -> int:
    import torch
    from .model import MailwomanCoarseEncoder

    from .config import load_config
    from .eval import load_golden_dir, report_to_json, run_eval
    from .package_weights import (
        build_model_card,
        render_package_json,
        render_readme,
        write_package,
    )
    from .tokenizer import Tokenizer

    cfg = load_config(args.config)

    # Run a fresh eval pass so the model card numbers always match the int8 weights.
    ck_dir = Path(args.checkpoint)
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    model = MailwomanCoarseEncoder.from_pretrained(ck_dir)
    eval_report_dict: dict
    if args.golden_dir or cfg.eval.golden_dir:
        golden_dir = Path(args.golden_dir or cfg.eval.golden_dir)
        entries = load_golden_dir(golden_dir)
        report = run_eval(cfg, model, tokenizer, entries)
        eval_report_dict = report_to_json(report)
    else:
        eval_report_dict = {
            "n_entries": 0,
            "full_parse_exact_match": 0.0,
            "mean_token_confidence": 0.0,
            "per_component": {},
            "calibration": [],
            "note": "no golden_dir provided; eval skipped",
        }

    int8_path = Path(args.int8_model)
    tokenizer_model_path = Path(cfg.data.tokenizer_dir) / "tokenizer.model"
    pkg_root = Path(args.packages_root)
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
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
        pkg_json = render_package_json(locale, package_version=args.package_version)
        readme = render_readme(
            locale=locale,
            corpus_version=args.corpus_version,
            eval_report=eval_report_dict,
            training_steps=args.steps,
            training_hardware=args.hardware,
            smoke=args.smoke,
        )
        write_package(
            pkg_dir,
            int8_model_path=int8_path,
            tokenizer_model_path=tokenizer_model_path,
            model_card=card,
            package_json=pkg_json,
            readme_md=readme,
        )
        print(f"wrote weights package → {pkg_dir}")
    return 0


def cmd_smoke(args: argparse.Namespace) -> int:
    """End-to-end smoke: train → eval → export → quantize → package."""
    from .config import load_config
    from .train import train as train_fn

    cfg = load_config(args.config)
    # Smokes default to constant-LR per the v0.5.0 verdict-smoke framework
    # (docs/articles/plan/reference/VERDICT_SMOKES.md). Operator may opt into
    # ``--smoke-mode long-tail`` for tweaks on a known-stable baseline.
    if getattr(args, "smoke_mode", None) is None:
        args.smoke_mode = "constant"
    _apply_smoke_mode(args, cfg)
    started = time.time()
    train_fn(cfg)
    # Pick the latest checkpoint.
    output_dir = Path(cfg.train.output_dir)
    ckpts = sorted(output_dir.glob("step-*"))
    if not ckpts:
        sys.stderr.write("smoke: no checkpoints written\n")
        return 1
    ck = ckpts[-1]
    print(f"smoke: using checkpoint {ck}")

    # Eval against golden set.
    from .eval import (
        load_golden_dir,
        render_report_markdown,
        report_to_json,
        run_eval,
    )
    from .tokenizer import Tokenizer
    from .model import MailwomanCoarseEncoder
    import torch

    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    model = MailwomanCoarseEncoder.from_pretrained(ck)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    golden_dir = Path(args.golden_dir or "data/eval/golden/v0.1.0")
    entries = load_golden_dir(golden_dir)
    report = run_eval(cfg, model, tokenizer, entries, device=device)
    (ck / "eval-report.md").write_text(
        render_report_markdown(report, header="Smoke eval"), encoding="utf-8"
    )
    (ck / "eval-report.json").write_text(
        json.dumps(report_to_json(report), indent=2) + "\n", encoding="utf-8"
    )

    # Export to ONNX.
    from .export_onnx import export_to_onnx, verify_parity

    onnx_dir = Path("/data/models/onnx")
    fp32_path = onnx_dir / f"model-{Path(cfg.train.output_dir).name}-fp32.onnx"
    export_to_onnx(
        model,
        fp32_path,
        max_length=cfg.data.max_length,
        pad_token_id=tokenizer.pad_id,
    )
    # 32 val samples for parity at smoke scale.
    from .data_loader import iter_batches

    samples = []
    for batch in iter_batches(cfg, tokenizer, split="val", batch_size=1, seed=0, row_limit=32):
        samples.append((batch["input_ids"][0], batch["attention_mask"][0]))
        if len(samples) >= 32:
            break
    parity = verify_parity(model, fp32_path, samples, atol=1e-4)
    print(f"smoke: ONNX parity {parity}")

    # Quantize.
    from .quantize import quantize_dynamic_int8

    quant_dir = Path("/data/models/quantized")
    int8_path = quant_dir / f"model-{Path(cfg.train.output_dir).name}-int8.onnx"
    quantize_dynamic_int8(fp32_path, int8_path)
    print(f"smoke: int8 → {int8_path}")

    # Package.
    from .package_weights import (
        build_model_card,
        render_package_json,
        render_readme,
        write_package,
    )

    elapsed = time.time() - started
    # Resolve the workspace packages/ directory: walk up from this file until we find a
    # directory containing a sibling ``packages/`` (or the well-known root marker). This
    # avoids the CWD-dependent ``Path("packages")`` trap.
    packages_root = _find_packages_root()
    for locale in ["en-us", "fr-fr"]:
        pkg_dir = packages_root / f"neural-weights-{locale}"
        card = build_model_card(
            locale=locale,
            corpus_version=Path(cfg.data.corpus_dir).name.replace("corpus-", ""),
            tokenizer_version="0.1.0",
            training_steps=cfg.train.max_steps,
            eval_report=report_to_json(report),
            notes="SMOKE BUILD — pipeline-validation only, not production weights.",
            training_hardware=("cuda" if torch.cuda.is_available() else "cpu") + " (smoke)",
            training_duration_seconds=elapsed,
            base_path=ck,
        )
        pkg_json = render_package_json(locale)
        readme = render_readme(
            locale=locale,
            corpus_version=Path(cfg.data.corpus_dir).name,
            eval_report=report_to_json(report),
            training_steps=cfg.train.max_steps,
            training_hardware=("cuda" if torch.cuda.is_available() else "cpu") + " (smoke)",
            smoke=True,
        )
        write_package(
            pkg_dir,
            int8_model_path=int8_path,
            tokenizer_model_path=Path(cfg.data.tokenizer_dir) / "tokenizer.model",
            model_card=card,
            package_json=pkg_json,
            readme_md=readme,
        )
        print(f"smoke: weights package → {pkg_dir}")

    print("smoke: OK")
    return 0


_CORPUS_VERSIONED_ROOT = Path("/data/corpus/versioned")


def _resolve_corpus_dir(spec: str) -> Path:
    """Resolve a ``--corpus`` argument into a concrete shard-tree path.

    Accepts three forms:

    1. ``vX.Y.Z`` (or ``X.Y.Z``) — looks under ``/data/corpus/versioned/vX.Y.Z/corpus-vX.Y.Z/``.
    2. An absolute or relative path that already contains ``train/*.parquet``.
    3. An absolute or relative path one level up (with ``corpus-v*`` child).
    """
    p = Path(spec)
    if p.is_absolute() and (p / "train").is_dir():
        return p
    if p.exists() and (p / "train").is_dir():
        return p.resolve()
    # Path one level up — accept ``/data/corpus/versioned/v0.3.0`` and resolve inward.
    if p.exists() and p.is_dir():
        candidates = sorted(p.glob("corpus-v*"))
        if len(candidates) == 1 and (candidates[0] / "train").is_dir():
            return candidates[0].resolve()
    # Version-string form: ``v0.3.0`` or ``0.3.0``.
    ver = spec.lstrip("v")
    candidate = _CORPUS_VERSIONED_ROOT / f"v{ver}" / f"corpus-v{ver}"
    if (candidate / "train").is_dir():
        return candidate
    raise FileNotFoundError(
        f"could not resolve --corpus={spec!r}; tried {candidate}/train and direct path forms"
    )


def cmd_tokenizer(args: argparse.Namespace) -> int:
    """Train a SentencePiece tokenizer from a corpus version (v0.5.0 Thread A harness)."""
    import logging

    from .tokenizer_train import (
        DEFAULT_USER_DEFINED_SYMBOLS,
        TrainerConfig,
        parse_user_defined_symbols_file,
        train_tokenizer,
    )

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    corpus_dir = _resolve_corpus_dir(args.corpus)
    output_dir = Path(args.output)
    countries = tuple(c.strip() for c in args.countries.split(",") if c.strip())

    uds: list[str] = []
    if not args.no_default_user_defined_symbols:
        uds.extend(DEFAULT_USER_DEFINED_SYMBOLS)
    if args.user_defined_symbols_file:
        uds.extend(parse_user_defined_symbols_file(Path(args.user_defined_symbols_file)))

    cfg = TrainerConfig(
        corpus_dir=corpus_dir,
        output_dir=output_dir,
        corpus_version=args.corpus_version or _infer_corpus_version(corpus_dir),
        vocab_size=args.vocab,
        character_coverage=args.character_coverage,
        model_type=args.model_type,
        byte_fallback=not args.no_byte_fallback,
        split_digits=args.split_digits,
        allow_whitespace_only_pieces=False,
        per_country_sample=args.per_country_sample,
        countries=countries,
        mine_postcode_literals=args.mine_postcode_literals,
        user_defined_symbols=tuple(uds),
        eval_fixture=Path(args.eval_fixture) if args.eval_fixture else None,
        seed=args.seed,
    )
    card = train_tokenizer(cfg)
    print(json.dumps(card, indent=2))
    return 0


def _infer_corpus_version(corpus_dir: Path) -> str:
    """Best-effort: pull ``v0.3.0`` out of ``.../v0.3.0/corpus-v0.3.0`` paths."""
    name = corpus_dir.name
    if name.startswith("corpus-"):
        return name[len("corpus-"):]
    return name


def cmd_verify_tokenizer(args: argparse.Namespace) -> int:
    from .config import load_config
    from .data_loader import verify_tokenizer_alignment
    from .tokenizer import Tokenizer

    cfg = load_config(args.config)
    tokenizer = Tokenizer(Path(cfg.data.tokenizer_dir) / "tokenizer.model")
    verify_tokenizer_alignment(Path(cfg.data.corpus_dir), tokenizer, sample_size=args.sample)
    print(f"verified {args.sample} rows against {cfg.data.tokenizer_dir}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m mailwoman_train", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    common = lambda p: (
        p.add_argument("--config", default=None, help="Path to YAML config (optional)"),
    )

    p = sub.add_parser("train", help="Train a Stage 1 coarse model")
    common(p)
    p.add_argument("--output-dir", default=None)
    p.add_argument("--max-steps", type=int, default=None)
    p.add_argument(
        "--resume",
        default=None,
        help='Resume from this checkpoint dir, or pass "auto" to use the latest step-* under output_dir.',
    )
    p.add_argument(
        "--smoke-mode",
        choices=("constant", "long-tail"),
        default=None,
        help=(
            "Override LR schedule for a verdict-smoke run. 'constant' = flat LR after "
            "warmup so divergence isn't masked by cosine decay (default for new recipes). "
            "'long-tail' = keep cosine but expect max_steps>=10000 so the tail doesn't "
            "dominate the smoke window. See docs/articles/plan/reference/VERDICT_SMOKES.md."
        ),
    )
    p.set_defaults(func=cmd_train)

    p = sub.add_parser("eval", help="Eval a checkpoint against the golden set")
    common(p)
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--golden-dir", default=None)
    p.set_defaults(func=cmd_eval)

    p = sub.add_parser("export", help="Export a checkpoint to ONNX")
    common(p)
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--opset", type=int, default=17)
    p.add_argument("--parity-samples", type=int, default=1000)
    p.add_argument("--tolerance", type=float, default=1e-4)
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("quantize", help="Int8 dynamic quantization of an ONNX model")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.set_defaults(func=cmd_quantize)

    p = sub.add_parser("package", help="Assemble neural-weights-* packages")
    common(p)
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--int8-model", required=True)
    p.add_argument("--packages-root", default="packages")
    p.add_argument("--locales", default="en-us,fr-fr")
    p.add_argument("--corpus-version", default="0.1.0")
    p.add_argument("--tokenizer-version", default="0.1.0")
    p.add_argument("--package-version", default="0.1.0", help="Version stamp for model-card.json + package.json")
    p.add_argument("--steps", type=int, default=0)
    p.add_argument("--hardware", default="")
    p.add_argument("--training-duration-seconds", type=float, default=0.0)
    p.add_argument("--notes", default="")
    p.add_argument("--golden-dir", default=None)
    p.add_argument("--smoke", action="store_true")
    p.set_defaults(func=cmd_package)

    p = sub.add_parser("smoke", help="End-to-end smoke train + eval + export + quantize + package")
    common(p)
    p.add_argument("--golden-dir", default=None)
    p.add_argument(
        "--smoke-mode",
        choices=("constant", "long-tail"),
        default=None,
        help=(
            "LR schedule for the smoke train leg. Defaults to 'constant' per the v0.5.0 "
            "verdict-smoke framework. See docs/articles/plan/reference/VERDICT_SMOKES.md."
        ),
    )
    p.set_defaults(func=cmd_smoke)

    p = sub.add_parser("verify-tokenizer", help="Re-tokenize a sample of corpus rows and assert OK")
    common(p)
    p.add_argument("--sample", type=int, default=100)
    p.set_defaults(func=cmd_verify_tokenizer)

    p = sub.add_parser(
        "tokenizer",
        help="Train a SentencePiece tokenizer from a corpus version (v0.5.0 Thread A).",
    )
    p.add_argument(
        "--corpus",
        required=True,
        help='Corpus to train on. Accepts "v0.3.0" / "0.3.0" (resolves under '
        '/data/corpus/versioned/vX.Y.Z/corpus-vX.Y.Z/) or an explicit shard-tree path '
        "(parent of train/, val/, test/).",
    )
    p.add_argument(
        "--corpus-version",
        default=None,
        help="Override the corpus_version stamp in the model card (auto-inferred from path).",
    )
    p.add_argument("--output", required=True, help="Output dir for tokenizer.model + model_card.json")
    p.add_argument("--vocab", type=int, default=48000, help="Vocabulary size (v0.5.0 default 48000)")
    p.add_argument(
        "--character-coverage",
        type=float,
        default=0.9999,
        help="SP character_coverage. v0.5.0 bumps to 0.9999 (from v0.1.0's 0.9995) for better non-Latin coverage.",
    )
    p.add_argument("--model-type", default="unigram", choices=["unigram", "bpe", "char", "word"])
    p.add_argument("--no-byte-fallback", action="store_true", help="Disable SP byte_fallback (default: enabled)")
    p.add_argument("--split-digits", action="store_true", help="Pass SP split_digits=true (default: false)")
    p.add_argument(
        "--countries",
        default="US,FR",
        help="Comma-separated country codes to sample raws from (default: US,FR)",
    )
    p.add_argument("--per-country-sample", type=int, default=500_000)
    p.add_argument(
        "--mine-postcode-literals",
        type=int,
        default=0,
        help="If > 0, mine the top-N postcode literals from the corpus and add them as user_defined_symbols.",
    )
    p.add_argument(
        "--user-defined-symbols-file",
        default=None,
        help="One literal per line (blank + ``#``-comments skipped). Appended to the default UDS list.",
    )
    p.add_argument(
        "--no-default-user-defined-symbols",
        action="store_true",
        help="Skip the built-in DEFAULT_USER_DEFINED_SYMBOLS list (US states + country abbrevs + postal markers).",
    )
    p.add_argument(
        "--eval-fixture",
        default=None,
        help="Path to a JSONL or text file of held-out lines. Used to compute the byte-fallback rate recorded in the model card.",
    )
    p.add_argument("--seed", type=int, default=42)
    p.set_defaults(func=cmd_tokenizer)

    return parser


def main(argv: list[str] | None = None) -> int:
    # Apply the gfx1103 SDPA workaround for every subcommand that touches torch.cuda. Math
    # SDPA is the only kernel that runs stably on Radeon 780M (flash + mem-efficient hang).
    # Importing torch lazily inside main keeps the CLI fast for help-only invocations.
    try:
        from .model import force_math_sdpa

        force_math_sdpa()
    except Exception:  # pragma: no cover — torch/transformers may not be installed
        pass
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
