"""Build a NOISY registry corpus for Taiwan (GCIS) or Japan (法人番号) from the aligned typed addresses (#2204 §5).

The LABEL corpora (`build_tw_slice.py`, the Overture-JP slice) render register rows in synthetic registers. This
builder writes the other half: the address strings a clerk typed into a company register, aligned against the same
LABEL key sets (`tw_registry.py`, `jp_registry.py`) and kept only where the whole key matches. The alignment rate is
measured over every row and written to the build report; a string that does not align is a board row, never a
training row.

Hold-out follows the LABEL corpus of the same locale exactly, so a typed address in a held-out unit is read, not
trained: Taiwan holds out 鄉鎮市區 by the (縣市|鄉鎮市區) hash at the TW board's bucket, Japan holds out municipalities
by the municipality hash at the JP board's bucket.

Usage:
    python -m mailwoman_train.build_registry_corpus tw --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-tw-registry-<date>
    python -m mailwoman_train.build_registry_corpus jp --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-registry-<date>
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import Counter
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from . import jp_registry, tw_registry
from .build_cjk_overlay import verify_cn_record
from .build_jp_slice import BOARD_BUCKET_MIN as JP_BOARD_BUCKET_MIN
from .build_tw_slice import BOARD_BUCKET_MIN as TW_BOARD_BUCKET_MIN
from .char_tokenizer import build_char_vocab, save_char_vocab
from .corpora.builder import SCHEMA, coverage_stats, muni_bucket, select_exact
from .labels import resolve_label_set
from .text.normalize import normalize_text

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
SOURCES = Path(DATA_ROOT) / "corpus" / "sources"
OVERTURE = Path(DATA_ROOT) / "overture" / "2026-06-17.0"
LABEL_SET_NAME = "stage3-cjk"

# One aligned string with its hold-out key and the projected coordinate (registers carry none, so it is None).
Candidate = tuple[dict[str, Any], str]


def tw_candidates(index: tw_registry.TWKeyIndex) -> Iterator[tuple[Candidate | None, str]]:
    """(aligned record + unit key, or None) and the raw string, for every address form of every register row."""
    for row in tw_registry.iter_register_rows(SOURCES / "gcis-tw"):
        for text in (row.address, row.tax_address):
            if not text:
                continue
            aligned = tw_registry.align_register_address(text, index)
            if aligned is None:
                yield None, text
            else:
                yield (tw_registry.to_record(aligned), normalize_text(f"{aligned.region}|{aligned.district}")), text


def jp_candidates(
    index: jp_registry.JPKeyIndex, rng: random.Random, postcode_fraction: float
) -> Iterator[tuple[Candidate | None, str]]:
    for row in jp_registry.iter_corporate_rows(SOURCES / "houjin-jp" / "00_zenkoku_all_20260831.zip"):
        aligned = jp_registry.align_corporate_row(row, index, with_postcode=rng.random() < postcode_fraction)
        text = f"{row.prefecture}{row.municipality}{row.street}"
        if aligned is None:
            yield None, text
        else:
            yield (jp_registry.to_record(aligned), aligned.municipality), text


LOCALES: dict[str, dict[str, Any]] = {
    "tw": {
        "source": tw_registry.SOURCE,
        "bucket_min": TW_BOARD_BUCKET_MIN,
        "part": "tw-registry",
        "board": "tw-registry-board.jsonl",
        "vocab": "char-vocab-tw-registry.json",
    },
    "jp": {
        "source": jp_registry.SOURCE,
        "bucket_min": JP_BOARD_BUCKET_MIN,
        "part": "jp-registry",
        "board": "jp-registry-board.jsonl",
        "vocab": "char-vocab-jp-registry.json",
    },
}


def build(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    locale = LOCALES[args.locale]
    out_dir = Path(args.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise SystemExit(f"{out_dir} exists and is non-empty — pass --force to overwrite")

    if args.locale == "tw":
        index: Any = tw_registry.TWKeyIndex.from_parquet(OVERTURE / "addresses-tw.parquet", args.max_row_groups)
        candidates: Callable[[], Iterator[tuple[Candidate | None, str]]] = lambda: tw_candidates(index)  # noqa: E731
    else:
        index = jp_registry.JPKeyIndex.from_parquet(OVERTURE / "addresses-jp.parquet", args.max_row_groups)
        # A separate stream for the postcode coin. Seeded like the selector it would draw in lockstep with it — one
        # draw per row each — and a selected row (draw < 0.12) would always be a postcode row (draw < 0.3): the first
        # build read 199,960 of 200,000 rows with a 〒 prefix at a fraction of 0.3.
        candidates = lambda: jp_candidates(index, random.Random(f"{args.seed}-postcode"), args.postcode_fraction)  # noqa: E731
    print(f"index built for {args.locale}")

    # Pass 1: the census. Pass 2 draws the exact selection against the counts pass 1 measured.
    counts: Counter[str] = Counter()
    for candidate, _text in candidates():
        if candidate is None:
            counts["unaligned"] += 1
        elif muni_bucket(candidate[1]) >= locale["bucket_min"]:
            counts["held_out"] += 1
        else:
            counts["aligned"] += 1
    total = sum(counts.values())
    print(
        f"pass 1: {total:,} strings — {dict(counts)} · alignment {(counts['aligned'] + counts['held_out']) / max(total, 1):.4f}"
    )

    train_selector = select_exact(counts["aligned"], args.rows, rng)
    board_selector = select_exact(counts["held_out"] + counts["unaligned"], args.board_rows, rng)
    rows: list[dict[str, Any]] = []
    board: list[dict[str, Any]] = []
    tags: Counter[str] = Counter()
    for candidate, text in candidates():
        if candidate is None:
            if next(board_selector):
                board.append({"raw": text, "aligned": False})
            continue
        record, unit = candidate
        if muni_bucket(unit) >= locale["bucket_min"]:
            if next(board_selector):
                board.append(
                    {
                        "raw": record["raw"],
                        "span_starts": record["span_starts"],
                        "span_ends": record["span_ends"],
                        "span_tags": record["span_tags"],
                        "aligned": True,
                        "unit": unit,
                    }
                )
        elif next(train_selector):
            verify_cn_record(record, tag_set)
            tags.update(record["span_tags"])
            rows.append(record)
    rng.shuffle(rows)
    val_rows = max(1, int(len(rows) * args.val_fraction))
    splits: dict[str, dict[str, Any]] = {}
    for split, subset in (("train", rows[val_rows:]), ("val", rows[:val_rows])):
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        part = 0
        for start in range(0, len(subset), args.rows_per_part):
            chunk = subset[start : start + args.rows_per_part]
            pq.write_table(
                pa.Table.from_pylist(chunk, schema=SCHEMA), out_dir / split / f"{locale['part']}-{part:04d}.parquet"
            )
            part += 1
        splits[split] = {"rows": len(subset), "parts": part, "coverage": coverage_stats(subset[: args.stats_sample])}
        print(f"{split}: {len(subset):,} rows in {part} parts")
    with (out_dir / locale["board"]).open("w", encoding="utf-8") as handle:
        for entry in board:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def raws() -> Iterator[str]:
        for path in sorted((out_dir / "train").glob("*.parquet")):
            yield from pq.read_table(path, columns=["raw"])["raw"].to_pylist()

    vocab = build_char_vocab(raws(), min_count=2)
    save_char_vocab(vocab, out_dir / locale["vocab"])
    report = {
        "locale": args.locale,
        "source": locale["source"],
        "label_set": LABEL_SET_NAME,
        "seed": args.seed,
        "alignment_census": dict(counts),
        "alignment_rate": (counts["aligned"] + counts["held_out"]) / max(total, 1),
        "board_bucket_min": locale["bucket_min"],
        "span_tags": dict(tags.most_common()),
        "splits": splits,
        "board_rows": len(board),
        "char_vocab_size": len(vocab),
    }
    (out_dir / "build-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({k: v for k, v in report.items() if k != "splits"}, ensure_ascii=False, indent=2))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", maxsplit=1)[0])
    parser.add_argument("locale", choices=sorted(LOCALES))
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--rows", type=int, default=500_000)
    parser.add_argument("--val-fraction", type=float, default=0.02)
    parser.add_argument("--board-rows", type=int, default=20_000)
    parser.add_argument("--postcode-fraction", type=float, default=0.3, help="jp: the share rendered with a 〒 prefix")
    parser.add_argument("--rows-per-part", type=int, default=250_000)
    parser.add_argument("--stats-sample", type=int, default=50_000)
    parser.add_argument(
        "--max-row-groups", type=int, default=None, help="smoke builds: key index from this many row groups"
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
