"""The one entry point, which picks a mode and hands it the files that mode writes."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .client import DEFAULT_MODEL, require_api_key
from .kryptonite import emit_kryptonite
from .run import Sink
from .transliteration import emit_transliteration


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["transliteration", "kryptonite"], required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--batch-size", type=int, default=50)
    ap.add_argument("--concurrency", type=int, default=15)
    ap.add_argument("--max-tokens", type=int, default=20000)
    ap.add_argument("--seed-paths", nargs="*", default=[])
    ap.add_argument("--scripts", nargs="*", default=None, help="subset of script slugs (cyrl jpan hans hang armn)")
    ap.add_argument("--target-count", type=int, default=8000, help="kryptonite total target")
    ap.add_argument("--limit", type=int, default=0, help="cap seeds (transliteration)")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.mode == "transliteration" and not args.seed_paths:
        print("--seed-paths required for transliteration mode", file=sys.stderr)
        sys.exit(2)

    # The key is required before anything is loaded, so a missing one fails beside its cause.
    api_key = require_api_key()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.mode == "transliteration":
        sink = Sink(out_dir / "canonical-transliteration.jsonl", out_dir / "raw-deepseek-transliteration.jsonl")
        emit_transliteration(args, api_key, sink, out_dir / ".translit-checkpoint.json")
    else:
        sink = Sink(out_dir / "canonical-kryptonite.jsonl", out_dir / "raw-deepseek-kryptonite.jsonl")
        emit_kryptonite(args, api_key, sink, out_dir / ".kryptonite-checkpoint.json")
