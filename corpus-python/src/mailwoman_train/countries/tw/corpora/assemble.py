"""The two passes that turn eligible Overture-TW rows into a slice.

Pass 1 MEASURES: it counts eligible rows per 縣市, sums each district's coordinates and lists the
agencies, and it draws nothing. Pass 2 SELECTS under the quotas pass 1 set. Both stream the same
parquet in the same order, which is what makes the second pass's exact selectors land on the rows
the first pass counted.

One `random.Random` feeds the selectors, the shuffle, each row's register and the country prefix, in
that order. Adding, dropping or reordering a draw reshuffles which addresses a seeded build trains
on, and no artifact says so.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter, defaultdict
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ....corpora.builder import (
    MAX_FIELD_CHARS,
    SCHEMA,
    coverage_stats,
    muni_bucket,
    select_exact,
    water_fill,
)
from ....labels import resolve_label_set
from ....paths import resolve_data_root_default
from ....text.normalize import normalize_text
from ....tokenizer.char import build_char_vocab, save_char_vocab
from .rows import (
    BOARD_BUCKET_MIN,
    LABEL_SET_NAME,
    PARQUET_PARTS,
    REGISTER_WEIGHTS,
    SOURCE,
    SourceRow,
    available_registers,
    choose_register,
    iter_source_rows,
    render_row,
    verify_record,
)


@dataclass(frozen=True)
class SourceSurvey:
    """Pass 1's answer: the quotas pass 2 selects under, plus the sums the centroids come from.

    The centroid sums are taken over EVERY eligible row, not over the selected ones: a board row is
    scored against its district's centre, and a centre computed from the handful of rows selection
    happened to keep is a different place.
    """

    scanned: int
    dropped: Counter[str]
    agencies: Counter[str]
    pool_counts: Counter[str]
    board_count: int
    cap: int
    quotas: dict[str, int]
    centroid_sums: dict[str, list[float]]

    def centroids(self) -> dict[str, list[float]]:
        return {key: [s[0] / s[2], s[1] / s[2]] for key, s in self.centroid_sums.items() if s[2]}


@dataclass(frozen=True)
class Selection:
    """Pass 2's answer: the source rows each split will render, already shuffled."""

    train: list[SourceRow]
    val: list[SourceRow]
    board: list[SourceRow]


def survey_source(parquet: Path, args: argparse.Namespace) -> SourceSurvey:
    """Pass 1: count eligible rows per 縣市, sum each district's coordinates, list the agencies.

    Draws nothing. The agency list is not bookkeeping — the Taiwanese licence voids its grant on a
    missing attribution, so the report carries the datasets the rows actually came from.
    """
    pool_counts: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    agencies: Counter[str] = Counter()
    centroid_sums: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    board_count = scanned = 0
    for region, district, _village, _street, _number, _unit, lon, lat in iter_source_rows(
        parquet, args.max_row_groups, args.max_field_chars, dropped, agencies
    ):
        scanned += 1
        sums = centroid_sums[normalize_text(f"{region}|{district}")]
        sums[0] += lon
        sums[1] += lat
        sums[2] += 1
        if muni_bucket(f"{region}|{district}") >= args.board_bucket_min:
            board_count += 1
        else:
            pool_counts[region] += 1
    print(f"pass 1: {scanned:,} eligible rows · {len(pool_counts)} regions · board pool {board_count:,}")
    print(f"pass 1: dropped {dict(dropped)} · {len(agencies)} source agencies")
    drop_rate = sum(dropped.values()) / max(scanned + sum(dropped.values()), 1)
    if drop_rate > 0.02:
        raise RuntimeError(
            f"source drop rate {drop_rate:.4f} exceeds 2% — the eligibility filter no longer fits the data"
        )

    target = args.train_rows + args.val_rows
    cap = water_fill(pool_counts, target)
    quotas = {region: min(cap, count) for region, count in pool_counts.items()}
    shortfall = target - sum(quotas.values())
    if shortfall > 0:
        for region in sorted(pool_counts, key=lambda r: pool_counts[r] - quotas[r], reverse=True):
            grant = min(pool_counts[region] - quotas[region], shortfall)
            quotas[region] += grant
            shortfall -= grant
            if shortfall <= 0:
                break
    print(f"pass 1: per-region cap {cap:,}; quota total {sum(quotas.values()):,} of target {target:,}")
    return SourceSurvey(scanned, dropped, agencies, pool_counts, board_count, cap, quotas, centroid_sums)


def select_rows(parquet: Path, args: argparse.Namespace, rng: random.Random, survey: SourceSurvey) -> Selection:
    """Pass 2: stream the exact selection under the quotas, then shuffle and divide into the splits."""
    selectors = {
        region: select_exact(survey.pool_counts[region], survey.quotas[region], rng) for region in survey.pool_counts
    }
    board_selector = select_exact(survey.board_count, args.board_rows, rng)
    selected: list[SourceRow] = []
    board: list[SourceRow] = []
    for row in iter_source_rows(parquet, args.max_row_groups, args.max_field_chars):
        if muni_bucket(f"{row[0]}|{row[1]}") >= args.board_bucket_min:
            if next(board_selector):
                board.append(row)
        elif next(selectors[row[0]]):
            selected.append(row)
    print(f"pass 2: selected {len(selected):,} pool rows · {len(board):,} board rows")

    rng.shuffle(selected)
    return Selection(
        selected[: args.train_rows],
        selected[args.train_rows : args.train_rows + args.val_rows],
        board,
    )


class RowEncoder:
    """Renders selected source rows, drawing the register and the country prefix off the shared `rng`.

    The register tally it accumulates is read by the build report, so one encoder serves the splits
    and the board rather than each keeping its own count.
    """

    def __init__(self, args: argparse.Namespace, rng: random.Random, tag_set: frozenset[str]) -> None:
        self.args = args
        self.rng = rng
        self.tag_set = tag_set
        self.register_counts: Counter[str] = Counter()

    def encode(self, row: SourceRow) -> dict[str, Any]:
        region, district, village, street, house_number, unit, _lon, _lat = row
        register = choose_register(self.rng, available_registers(village, unit))
        self.register_counts[register] += 1
        record = render_row(
            region=region,
            district=district,
            village=village,
            street=street,
            house_number=house_number,
            unit=unit,
            register=register,
            country=self.rng.random() < self.args.country_fraction,
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
        part = written = 0
        for start in range(0, len(source_rows), args.rows_per_part):
            chunk = [encoder.encode(row) for row in source_rows[start : start + args.rows_per_part]]
            pq.write_table(pa.Table.from_pylist(chunk, schema=SCHEMA), out_dir / split / f"tw-part-{part:04d}.parquet")
            part += 1
            written += len(chunk)
            stats_input.extend(chunk[: args.stats_sample_per_part])
        splits[split] = {"rows": written, "parts": part, "coverage": coverage_stats(stats_input)}
        print(f"{split}: {written:,} rows in {part} parts")
    return splits


def write_board(out_dir: Path, selection: Selection, encoder: RowEncoder) -> list[dict[str, Any]]:
    """Write the held-out board: every row carries its coordinate and its routing fields."""
    board_records: list[dict[str, Any]] = []
    with (out_dir / "tw-board.jsonl").open("w", encoding="utf-8") as handle:
        for row in selection.board:
            region, district, village, street, house_number, unit, lon, lat = row
            record = encoder.encode(row)
            board_records.append(record)
            handle.write(
                json.dumps(
                    {
                        "raw": record["raw"],
                        "span_starts": record["span_starts"],
                        "span_ends": record["span_ends"],
                        "span_tags": record["span_tags"],
                        "register": record["register"],
                        "region": region,
                        "city": district,
                        "district": village,
                        "street": street,
                        "number": house_number,
                        "unit": unit,
                        "lon": lon,
                        "lat": lat,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return board_records


def check_stratification(selection: Selection) -> set[str]:
    """Violations RAISE; a slice that fails one is not a slice. Returns the board's 鄉鎮市區."""
    pool_units = {normalize_text(f"{row[0]}|{row[1]}") for row in selection.train} | {
        normalize_text(f"{row[0]}|{row[1]}") for row in selection.val
    }
    board_units = {normalize_text(f"{row[0]}|{row[1]}") for row in selection.board}
    overlap = pool_units & board_units
    if overlap:
        raise RuntimeError(f"board 鄉鎮市區 leak into train/val: {sorted(overlap)[:5]}")
    return board_units


def build(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    parquet = Path(args.parquet)

    survey = survey_source(parquet, args)
    selection = select_rows(parquet, args, rng, survey)
    encoder = RowEncoder(args, rng, tag_set)

    out_dir = Path(args.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise SystemExit(
            f"{out_dir} exists and is non-empty — pass --force to overwrite (a slice is a read-only artifact)"
        )

    splits = write_splits(out_dir, args, selection, encoder)
    board_records = write_board(out_dir, selection, encoder)
    board_units = check_stratification(selection)

    centroids = survey.centroids()
    (out_dir / "tw-district-centroids.json").write_text(
        json.dumps(centroids, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    def train_raws() -> Iterator[str]:
        for path in sorted((out_dir / "train").glob("*.parquet")):
            yield from pq.read_table(path, columns=["raw"])["raw"].to_pylist()

    vocab = build_char_vocab(train_raws(), min_count=2)
    save_char_vocab(vocab, out_dir / "char-vocab-tw.json")

    report = {
        "seed": args.seed,
        "parquet": str(parquet),
        "label_set": LABEL_SET_NAME,
        "source": SOURCE,
        "license": "CDLA-Permissive-2.0 (Overture) over CC BY 4.0 per civil-affairs bureau; 政府資料開放授權條款 attribution required",
        "attribution": dict(survey.agencies.most_common()),
        "eligible_rows_scanned": survey.scanned,
        "dropped_at_source": dict(survey.dropped.most_common()),
        "per_region_cap": survey.cap,
        "regions_train": len({row[0] for row in selection.train}),
        "board_bucket_min": args.board_bucket_min,
        "board_districts": len(board_units),
        "board_rows": len(board_records),
        "registers": dict(encoder.register_counts.most_common()),
        "char_vocab_size": len(vocab),
        "centroid_units": len(centroids),
        "fractions": {"country": args.country_fraction},
        "register_weights": REGISTER_WEIGHTS,
        "splits": splits,
        "board_coverage": coverage_stats(board_records),
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps({key: value for key, value in report.items() if key != "attribution"}, ensure_ascii=False, indent=2)
    )
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n", maxsplit=1)[0])
    parser.add_argument("--parquet", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(PARQUET_PARTS))
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--train-rows", type=int, default=2_000_000)
    parser.add_argument("--val-rows", type=int, default=20_000)
    parser.add_argument("--board-rows", type=int, default=20_000)
    parser.add_argument("--board-bucket-min", type=int, default=BOARD_BUCKET_MIN)
    parser.add_argument("--rows-per-part", type=int, default=250_000)
    parser.add_argument("--stats-sample-per-part", type=int, default=50_000)
    parser.add_argument("--country-fraction", type=float, default=0.05)
    parser.add_argument("--max-field-chars", type=int, default=MAX_FIELD_CHARS)
    parser.add_argument("--max-row-groups", type=int, default=None, help="smoke builds: read this many row groups")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true", help="overwrite a non-empty --out-dir")
    args = parser.parse_args(argv)
    args.parquet = resolve_data_root_default(args.parquet, *PARQUET_PARTS)
    return args


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
