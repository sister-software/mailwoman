"""`tokenizer` — train a versioned SentencePiece tokenizer from a corpus slice tree.

Writes `tokenizer.model` beside a model card carrying the byte-fallback rate measured on a held-out
fixture, so a tokenizer's coverage is a recorded number rather than a claim.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

NAME = "tokenizer"

#: Where a bare version string resolves. A `--corpus` that is already a path never reaches here.
CORPUS_VERSIONED_ROOT = Path("/data/corpus/versioned")


def add_parser(subparsers: Any) -> None:
    parser = subparsers.add_parser(NAME, help="Train a SentencePiece tokenizer from a corpus version")
    parser.add_argument(
        "--corpus",
        required=True,
        help='Corpus to train on. Accepts "v0.3.0" / "0.3.0" (resolves under '
        "/data/corpus/versioned/vX.Y.Z/corpus-vX.Y.Z/) or an explicit slice-tree path "
        "(parent of train/, val/, test/).",
    )
    parser.add_argument(
        "--corpus-version",
        default=None,
        help="Override the corpus_version stamp in the model card (auto-inferred from path).",
    )
    parser.add_argument("--output", required=True, help="Output dir for tokenizer.model + model_card.json")
    parser.add_argument("--vocab", type=int, default=48000, help="Vocabulary size")
    parser.add_argument(
        "--character-coverage",
        type=float,
        default=0.9999,
        help="SP character_coverage. 0.9999 rather than 0.9995, for better non-Latin coverage.",
    )
    parser.add_argument("--model-type", default="unigram", choices=["unigram", "bpe", "char", "word"])
    parser.add_argument("--no-byte-fallback", action="store_true", help="Disable SP byte_fallback (default: enabled)")
    parser.add_argument("--split-digits", action="store_true", help="Pass SP split_digits=true (default: false)")
    parser.add_argument(
        "--countries",
        default="US,FR",
        help="Comma-separated country codes to sample raws from (default: US,FR)",
    )
    parser.add_argument("--per-country-sample", type=int, default=500_000)
    parser.add_argument(
        "--mine-postcode-literals",
        type=int,
        default=0,
        help="If > 0, mine the top-N postcode literals from the corpus and add them as user_defined_symbols.",
    )
    parser.add_argument(
        "--user-defined-symbols-file",
        default=None,
        help="One literal per line (blank + ``#``-comments skipped). Appended to the default list.",
    )
    parser.add_argument(
        "--no-default-user-defined-symbols",
        action="store_true",
        help="Skip the built-in DEFAULT_USER_DEFINED_SYMBOLS list (US states + country abbrevs + postal markers).",
    )
    parser.add_argument(
        "--eval-fixture",
        default=None,
        help="A JSONL or text file of held-out lines, for the byte-fallback rate recorded in the card.",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.set_defaults(func=run)


def resolve_corpus_dir(spec: str) -> Path:
    """Resolve a `--corpus` argument into a concrete slice-tree path.

    Accepts three forms: a version string (`v0.3.0` or `0.3.0`), a path that already holds
    `train/`, and a path one level above one that does.
    """
    path = Path(spec)
    if path.is_absolute() and (path / "train").is_dir():
        return path
    if path.exists() and (path / "train").is_dir():
        return path.resolve()
    if path.exists() and path.is_dir():
        candidates = sorted(path.glob("corpus-v*"))
        if len(candidates) == 1 and (candidates[0] / "train").is_dir():
            return candidates[0].resolve()
    version = spec.lstrip("v")
    candidate = CORPUS_VERSIONED_ROOT / f"v{version}" / f"corpus-v{version}"
    if (candidate / "train").is_dir():
        return candidate
    raise FileNotFoundError(f"could not resolve --corpus={spec!r}; tried {candidate}/train and direct path forms")


def infer_corpus_version(corpus_dir: Path) -> str:
    """Pull `v0.3.0` out of a `.../v0.3.0/corpus-v0.3.0` path, or answer the directory name."""
    name = corpus_dir.name
    return name[len("corpus-") :] if name.startswith("corpus-") else name


def run(args: argparse.Namespace) -> int:
    import logging

    from ...tokenizer.train import (
        DEFAULT_USER_DEFINED_SYMBOLS,
        TrainerConfig,
        parse_user_defined_symbols_file,
        train_tokenizer,
    )

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    corpus_dir = resolve_corpus_dir(args.corpus)
    symbols: list[str] = []
    if not args.no_default_user_defined_symbols:
        symbols.extend(DEFAULT_USER_DEFINED_SYMBOLS)
    if args.user_defined_symbols_file:
        symbols.extend(parse_user_defined_symbols_file(Path(args.user_defined_symbols_file)))

    cfg = TrainerConfig(
        corpus_dir=corpus_dir,
        output_dir=Path(args.output),
        corpus_version=args.corpus_version or infer_corpus_version(corpus_dir),
        vocab_size=args.vocab,
        character_coverage=args.character_coverage,
        model_type=args.model_type,
        byte_fallback=not args.no_byte_fallback,
        split_digits=args.split_digits,
        allow_whitespace_only_pieces=False,
        per_country_sample=args.per_country_sample,
        countries=tuple(code.strip() for code in args.countries.split(",") if code.strip()),
        mine_postcode_literals=args.mine_postcode_literals,
        user_defined_symbols=tuple(symbols),
        eval_fixture=Path(args.eval_fixture) if args.eval_fixture else None,
        seed=args.seed,
    )
    print(json.dumps(train_tokenizer(cfg), indent=2))
    return 0
