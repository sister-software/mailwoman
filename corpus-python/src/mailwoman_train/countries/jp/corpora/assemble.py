"""Assembling the Japan slice: survey, select, render, write, report.

ONE `random.Random` runs through every stage below — the exact-selection masks, the shuffle, the
register draw, and each per-row fraction. They share a stream, so the ORDER these stages run in and
the order of the draws inside them decide what the slice contains.
`tests/mailwoman_train/countries/test_jp_build_parity.py` pins the emitted rows for that reason.

Two passes over the source rather than one: pass 1 counts eligible rows per prefecture so the
per-prefecture cap can be water-filled against the target, and pass 2 streams the selection under
that cap. Holding pass 1's rows to avoid pass 2 would mean 19.5M rendered records in memory.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ....corpora.builder import MAX_FIELD_CHARS, SCHEMA, coverage_stats, muni_bucket, select_exact, water_fill
from ....labels import resolve_label_set
from ....paths import resolve_data_root_default
from ....text.normalize import normalize_text
from ....tokenizer.char import build_char_vocab, save_char_vocab
from ..kana import municipality_kana_from_admin_db, municipality_kana_lookup
from ..text import VARIANT_HYPHENS, split_street
from .rows import (
    LABEL_SET_NAME,
    REGISTER_WEIGHTS,
    SOURCE,
    available_registers,
    choose_register,
    render_row,
    verify_record,
)
from .sources import ADMIN_DB_PARTS, KENALL_PARTS, PARQUET_PARTS, KenAllIndex, iter_source_rows, load_kenall_postcodes

# Municipality bucket split, IDENTICAL to the probe (md5 of the NFC space-stripped kanji, mod 100,
# board at >= 97). Keeping the rule byte-identical means the probe's held-out board municipalities
# stay held out here — a Phase-4 model can be graded on the Leg-1 board without leakage.
BOARD_BUCKET_MIN = 97

#: What `iter_source_rows` yields: (prefecture, municipality, street, number, lon, lat).
SourceRow = tuple[str, str, str, str, float, float]


@dataclass(frozen=True)
class SourceSurvey:
    """Pass 1's answer: how many eligible rows each prefecture has, and the quota each one gets."""

    scanned: int
    dropped: Counter[str]
    pool_counts: Counter[str]
    board_count: int
    cap: int
    quotas: dict[str, int]


@dataclass(frozen=True)
class Selection:
    """Pass 2's answer: the source rows each split will render, already shuffled."""

    train: list[SourceRow]
    val: list[SourceRow]
    board: list[SourceRow]
    upweighted: int


def survey_source(parquet: Path, args: argparse.Namespace) -> SourceSurvey:
    """Count eligible rows per prefecture and water-fill the per-prefecture cap. Draws nothing."""
    pool_counts: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    board_count = 0
    scanned = 0
    for prefecture, municipality, _street, _number, _lon, _lat in iter_source_rows(
        parquet, args.max_row_groups, args.max_field_chars, dropped
    ):
        scanned += 1
        if muni_bucket(municipality) >= BOARD_BUCKET_MIN:
            board_count += 1
        else:
            pool_counts[prefecture] += 1
    print(f"pass 1: {scanned:,} eligible rows · {len(pool_counts)} prefectures · board pool {board_count:,}")
    print(f"pass 1: dropped {dict(dropped)}")
    # A drop rate this filter was not designed for means the source changed shape, not that the tail
    # got longer — surface it rather than quietly shipping a differently-composed slice.
    drop_rate = sum(dropped.values()) / max(scanned + sum(dropped.values()), 1)
    if drop_rate > 0.02:
        raise RuntimeError(
            f"source drop rate {drop_rate:.4f} exceeds 2% — the eligibility filter no longer fits the data"
        )

    target = args.train_rows + args.val_rows
    cap = water_fill(pool_counts, target)
    quotas = {prefecture: min(cap, count) for prefecture, count in pool_counts.items()}
    shortfall = target - sum(quotas.values())
    # Water-filling lands at or below target; hand the remainder to the prefectures with headroom so
    # the slice hits its row count exactly rather than "about".
    if shortfall > 0:
        for prefecture in sorted(pool_counts, key=lambda p: pool_counts[p] - quotas[p], reverse=True):
            headroom = pool_counts[prefecture] - quotas[prefecture]
            grant = min(headroom, shortfall)
            quotas[prefecture] += grant
            shortfall -= grant
            if shortfall <= 0:
                break
    print(f"pass 1: per-prefecture cap {cap:,}; quota total {sum(quotas.values()):,} of target {target:,}")
    return SourceSurvey(scanned, dropped, pool_counts, board_count, cap, quotas)


def select_rows(parquet: Path, args: argparse.Namespace, rng: random.Random, survey: SourceSurvey) -> Selection:
    """Stream pass 2 under the quotas, then shuffle, divide into splits, and apply the upweight."""
    selectors = {p: select_exact(survey.pool_counts[p], survey.quotas[p], rng) for p in survey.pool_counts}
    board_selector = select_exact(survey.board_count, args.board_rows, rng)
    selected: list[SourceRow] = []
    board: list[SourceRow] = []
    for row in iter_source_rows(parquet, args.max_row_groups, args.max_field_chars):
        if muni_bucket(row[1]) >= BOARD_BUCKET_MIN:
            if next(board_selector):
                board.append(row)
        elif next(selectors[row[0]]):
            selected.append(row)
    print(f"pass 2: selected {len(selected):,} pool rows · {len(board):,} board rows")

    rng.shuffle(selected)
    train_source = selected[: args.train_rows]
    val_source = selected[args.train_rows : args.train_rows + args.val_rows]

    # Attested-row weight (#2178): a municipality NAME shape the head under-serves — 市 inside a 町 / 村 name
    # (市川三郷町, 市貝町, 余市町, 高市郡…) — is five municipalities and 21,043 of 19,587,889 source rows, about 0.1% of
    # train after selection. `--upweight-pattern REGEX:K` appends K-1 further copies of every selected train row
    # whose municipality matches, each rendered in its own draw of register, so the shape reaches the head at
    # K× its natural share without a synthetic name. Val and the board are untouched, so the read stays honest.
    upweighted = 0
    if args.upweight_pattern:
        pattern_text, _, factor_text = args.upweight_pattern.rpartition(":")
        pattern = re.compile(pattern_text)
        factor = int(factor_text)
        matching = [row for row in train_source if pattern.search(row[1])]
        for _ in range(factor - 1):
            train_source.extend(matching)
        upweighted = len(matching) * (factor - 1)
        rng.shuffle(train_source)
        print(
            f"upweight {pattern_text!r} ×{factor}: {len(matching):,} matching train rows, {upweighted:,} copies appended"
        )

    return Selection(train_source, val_source, board, upweighted)


class RowEncoder:
    """Renders selected source rows, drawing every per-row choice off the shared `rng`.

    The counters it accumulates — which KEN_ALL tier each postcode came from, and whether a row had
    every register available — are read by the build report, so one encoder serves the splits and
    the board rather than each keeping its own tally.
    """

    def __init__(
        self, args: argparse.Namespace, rng: random.Random, kenall: KenAllIndex, tag_set: frozenset[str]
    ) -> None:
        self.args = args
        self.rng = rng
        self.kenall = kenall
        self.tag_set = tag_set
        self.kenall_tiers: Counter[str] = Counter()
        self.register_unavailable: Counter[str] = Counter()
        self.kana_by_municipality = municipality_kana_from_admin_db(args.admin_db) if args.admin_db else {}
        print(f"[jp] kana readings for {len(self.kana_by_municipality):,} municipalities (#2165)", file=sys.stderr)

    def _postcode(self, prefecture: str, municipality: str, district: str) -> str | None:
        if self.rng.random() >= self.args.postcode_fraction:
            return None
        postcode, tier = self.kenall.lookup(prefecture, municipality, district)
        self.kenall_tiers[tier] += 1
        return postcode

    def encode(self, rows: Sequence[SourceRow]) -> list[dict[str, Any]]:
        """Render training rows: every register, and the variant-hyphen draw the board does without."""
        out: list[dict[str, Any]] = []
        for prefecture, municipality, street, number, _lon, _lat in rows:
            district, chome = split_street(street)
            municipality_kana = municipality_kana_lookup(self.kana_by_municipality, municipality)
            options = available_registers(chome, number, kana=municipality_kana is not None)
            self.register_unavailable["full" if len(options) == len(REGISTER_WEIGHTS) else "reduced"] += 1
            register = choose_register(self.rng, options)
            postcode = self._postcode(prefecture, municipality, district)
            hyphen = self.rng.choice(VARIANT_HYPHENS) if self.rng.random() < self.args.variant_hyphen_fraction else "-"
            record = render_row(
                prefecture=prefecture,
                municipality=municipality,
                district=district,
                chome=chome,
                number=number,
                postcode=postcode,
                register=register,
                spaced=self.rng.random() < self.args.spaced_fraction,
                country=self.rng.random() < self.args.country_fraction,
                hyphen=hyphen,
                municipality_kana=municipality_kana,
            )
            verify_record(record, self.tag_set)
            out.append(record)
        return out

    def board_record(self, row: SourceRow) -> dict[str, Any]:
        """Render one held-out row. No variant hyphen: the board reads the canonical surface."""
        prefecture, municipality, street, number, _lon, _lat = row
        district, chome = split_street(street)
        municipality_kana = municipality_kana_lookup(self.kana_by_municipality, municipality)
        register = choose_register(self.rng, available_registers(chome, number, kana=municipality_kana is not None))
        postcode = self._postcode(prefecture, municipality, district)
        record = render_row(
            prefecture=prefecture,
            municipality=municipality,
            district=district,
            chome=chome,
            number=number,
            postcode=postcode,
            register=register,
            spaced=self.rng.random() < self.args.spaced_fraction,
            country=self.rng.random() < self.args.country_fraction,
            municipality_kana=municipality_kana,
        )
        verify_record(record, self.tag_set)
        return record


def write_splits(
    out_dir: Path, args: argparse.Namespace, selection: Selection, encoder: RowEncoder
) -> dict[str, dict[str, Any]]:
    """Render and write train then val, in parts, keeping a bounded coverage sample per part."""
    splits: dict[str, dict[str, Any]] = {}
    for split, source_rows in (("train", selection.train), ("val", selection.val)):
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        stats_input: list[dict[str, Any]] = []
        part = 0
        written = 0
        for start in range(0, len(source_rows), args.rows_per_part):
            chunk = encoder.encode(source_rows[start : start + args.rows_per_part])
            table = pa.Table.from_pylist(chunk, schema=SCHEMA)
            pq.write_table(table, out_dir / split / f"part-{part:04d}.parquet")
            part += 1
            written += len(chunk)
            # Coverage is computed on a bounded sample per part so a 2M-row build stays memory-flat.
            stats_input.extend(chunk[: args.stats_sample_per_part])
        splits[split] = {"rows": written, "parts": part, "coverage": coverage_stats(stats_input)}
        print(
            f"{split}: {written:,} rows in {part} parts; "
            f"BIO char coverage {splits[split]['coverage']['bio_char_coverage_significant']:.4f}"
        )
    return splits


def write_board(out_dir: Path, selection: Selection, encoder: RowEncoder) -> list[dict[str, Any]]:
    """Write the held-out board as JSONL, carrying the source fields a grader needs beside the row."""
    board_records: list[dict[str, Any]] = []
    with (out_dir / "jp-board.jsonl").open("w", encoding="utf-8") as handle:
        for row in selection.board:
            prefecture, municipality, street, number, lon, lat = row
            record = encoder.board_record(row)
            board_records.append(record)
            handle.write(
                json.dumps(
                    {
                        "raw": record["raw"],
                        "span_starts": record["span_starts"],
                        "span_ends": record["span_ends"],
                        "span_tags": record["span_tags"],
                        "register": record["register"],
                        "pref": prefecture,
                        "muni": municipality,
                        "street": street,
                        "number": number,
                        "lon": lon,
                        "lat": lat,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return board_records


def check_stratification(args: argparse.Namespace, selection: Selection) -> tuple[set[str], set[str]]:
    """Violations RAISE; a slice that fails one is not a slice. Returns (train prefectures, board municipalities)."""
    train_prefectures = {row[0] for row in selection.train}
    if args.max_row_groups is None and len(train_prefectures) != 47:
        raise RuntimeError(f"train covers {len(train_prefectures)} prefectures, expected 47 — stratification broken")
    train_munis = {normalize_text(row[1]) for row in selection.train} | {
        normalize_text(row[1]) for row in selection.val
    }
    board_munis = {normalize_text(row[1]) for row in selection.board}
    overlap = train_munis & board_munis
    if overlap:
        raise RuntimeError(f"board municipalities leak into train/val: {sorted(overlap)[:5]}")
    return train_prefectures, board_munis


def build(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    kenall = load_kenall_postcodes(Path(args.kenall))
    parquet = Path(args.parquet)

    survey = survey_source(parquet, args)
    selection = select_rows(parquet, args, rng, survey)
    encoder = RowEncoder(args, rng, kenall, tag_set)

    out_dir = Path(args.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise SystemExit(
            f"{out_dir} exists and is non-empty — pass --force to overwrite (a slice is a read-only artifact)"
        )

    splits = write_splits(out_dir, args, selection, encoder)
    board_records = write_board(out_dir, selection, encoder)
    train_prefectures, board_munis = check_stratification(args, selection)

    # Char vocab (D2): sealed, rebuilt from the TRAIN split only, min_count=2.
    def train_raws() -> Iterator[str]:
        for path in sorted((out_dir / "train").glob("*.parquet")):
            table = pq.read_table(path, columns=["raw"])
            yield from table["raw"].to_pylist()

    vocab = build_char_vocab(train_raws(), min_count=2)
    save_char_vocab(vocab, out_dir / "char-vocab-jp-full.json")

    report = {
        "seed": args.seed,
        "source_parquet": str(parquet),
        "kenall": str(args.kenall),
        "label_set": LABEL_SET_NAME,
        "source": SOURCE,
        "eligible_rows_scanned": survey.scanned,
        "dropped_at_source": dict(survey.dropped.most_common()),
        "max_field_chars": args.max_field_chars,
        "per_prefecture_cap": survey.cap,
        "prefectures_train": len(train_prefectures),
        "board_municipalities": len(board_munis),
        "board_rows": len(board_records),
        "kenall_join_tiers": dict(encoder.kenall_tiers.most_common()),
        "register_availability": dict(encoder.register_unavailable),
        "char_vocab_size": len(vocab),
        "fractions": {
            "postcode": args.postcode_fraction,
            "country": args.country_fraction,
            "spaced": args.spaced_fraction,
            "variant_hyphen": args.variant_hyphen_fraction,
        },
        "register_weights": REGISTER_WEIGHTS,
        "upweight": {"pattern": args.upweight_pattern, "copies_appended": selection.upweighted},
        "splits": splits,
        "board_coverage": coverage_stats(board_records),
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--parquet", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(PARQUET_PARTS))
    parser.add_argument("--kenall", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(KENALL_PARTS))
    parser.add_argument(
        "--admin-db",
        default=None,
        help=(
            "WOF admin DB for the municipality kana readings (#2165); an empty string disables the register. "
            "Defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(ADMIN_DB_PARTS)
        ),
    )
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--train-rows", type=int, default=2_000_000)
    parser.add_argument("--val-rows", type=int, default=20_000)
    parser.add_argument("--board-rows", type=int, default=20_000)
    parser.add_argument("--rows-per-part", type=int, default=250_000)
    parser.add_argument("--stats-sample-per-part", type=int, default=50_000)
    parser.add_argument("--postcode-fraction", type=float, default=0.30)
    parser.add_argument("--country-fraction", type=float, default=0.10)
    parser.add_argument("--spaced-fraction", type=float, default=0.12)
    parser.add_argument("--variant-hyphen-fraction", type=float, default=0.05)
    parser.add_argument("--max-field-chars", type=int, default=MAX_FIELD_CHARS)
    parser.add_argument(
        "--max-row-groups", type=int, default=None, help="smoke slice: read only the first N row groups"
    )
    parser.add_argument(
        "--upweight-pattern",
        default=None,
        metavar="REGEX:K",
        help="append K-1 copies of every selected train row whose municipality matches REGEX (#2178)",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true", help="overwrite a non-empty --out-dir")
    args = parser.parse_args(argv)
    args.parquet = resolve_data_root_default(args.parquet, *PARQUET_PARTS)
    args.kenall = resolve_data_root_default(args.kenall, *KENALL_PARTS)
    # An explicit empty string disables the register, so only `None` means "use the default".
    if args.admin_db is None:
        args.admin_db = resolve_data_root_default(None, *ADMIN_DB_PARTS)
    return args


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))
