"""Build the Korean training corpus for the character-path CJK model from the road-name address register (#2204 §1, §5).

Four passes, two output corpora, one shared RNG. The first paragraph above is what `--help` prints,
so it stays a sentence about what the command does.

`survey.py` runs the two measuring passes; this module runs the two SELECTING ones and writes what
they choose. Passes 3 and 4 draw from the same `random.Random`, and
`tests/mailwoman_train/countries/test_kr_build_parity.py` pins what comes out — hoisting one draw
above another re-renders both corpora.
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ....corpora.builder import MAX_FIELD_CHARS, SCHEMA, coverage_stats, muni_bucket, select_exact
from ....corpora.builder import verify_cjk_record as verify_record
from ....labels import resolve_label_set
from ....paths import resolve_data_root_default
from ....tokenizer.char import build_char_vocab, save_char_vocab
from .. import registers
from ..juso import LabelRow, iter_label_rows
from .rows import (
    LABEL_SET_NAME,
    REGISTER_WEIGHTS,
    REGISTRY_SOURCE,
    SOURCE,
    available_registers,
    choose_register,
    choose_short_region,
    eligible,
    permit_alignment,
    registry_record,
    render_row,
    unit_key,
)
from .survey import PermitSurvey, RegisterSurvey, survey_permits, survey_register

#: Resolved after parsing, not here: reading the data root at import would raise for a caller who
#: passes the flags and never needs it.
JUSO_ZIP_PARTS = ("corpus", "sources", "juso-kr", "202608ALLMTCHG00.zip")
PERMIT_DIR_PARTS = ("corpus", "sources", "localdata-kr")
BOARD_BUCKET_MIN = 90


def select_register_rows(
    juso_zip: Path, args: argparse.Namespace, rng: random.Random, survey: RegisterSurvey
) -> tuple[list[LabelRow], list[LabelRow], list[LabelRow]]:
    """Pass 3: stream the exact selection under the quotas, then shuffle and divide into the splits."""
    selectors = {
        region: select_exact(survey.pool_counts[region], survey.quotas[region], rng) for region in survey.pool_counts
    }
    board_selector = select_exact(survey.board_count, args.board_rows, rng)
    selected: list[LabelRow] = []
    board: list[LabelRow] = []
    for row in iter_label_rows(juso_zip, args.max_rows_per_region):
        if eligible(row, args.max_field_chars):
            continue
        if muni_bucket(unit_key(row.region, row.sigungu)) >= args.board_bucket_min:
            if next(board_selector):
                board.append(row)
        elif next(selectors[row.region]):
            selected.append(row)
    print(f"pass 3: selected {len(selected):,} register rows · {len(board):,} board rows")

    rng.shuffle(selected)
    return selected[: args.train_rows], selected[args.train_rows : args.train_rows + args.val_rows], board


class LabelEncoder:
    """Renders register rows, drawing the register, the country prefix and the short form off `rng`."""

    def __init__(self, args: argparse.Namespace, rng: random.Random, tag_set: frozenset[str]) -> None:
        self.args = args
        self.rng = rng
        self.tag_set = tag_set
        self.register_counts: Counter[str] = Counter()

    def encode(self, row: LabelRow) -> dict[str, Any]:
        register = choose_register(self.rng, available_registers(row))
        self.register_counts[register] += 1
        record = render_row(
            row,
            register=register,
            country=self.rng.random() < self.args.country_fraction,
            short_region=choose_short_region(self.rng, row.region),
        )
        verify_record(record, self.tag_set)
        return record


def write_label_splits(
    out_dir: Path, args: argparse.Namespace, train: list[LabelRow], val: list[LabelRow], encoder: LabelEncoder
) -> dict[str, dict[str, Any]]:
    """Render and write the LABEL train and val splits, in parts, with a bounded coverage sample."""
    splits: dict[str, dict[str, Any]] = {}
    for split, source_rows in (("train", train), ("val", val)):
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        stats_input: list[dict[str, Any]] = []
        part = written = 0
        for start in range(0, len(source_rows), args.rows_per_part):
            chunk = [encoder.encode(row) for row in source_rows[start : start + args.rows_per_part]]
            pq.write_table(pa.Table.from_pylist(chunk, schema=SCHEMA), out_dir / split / f"kr-part-{part:04d}.parquet")
            part += 1
            written += len(chunk)
            stats_input.extend(chunk[: args.stats_sample_per_part])
        splits[split] = {"rows": written, "parts": part, "coverage": coverage_stats(stats_input)}
        print(f"{split}: {written:,} rows in {part} parts")
    return splits


def write_label_board(
    out_dir: Path, board: list[LabelRow], encoder: LabelEncoder, centroids: dict[str, list[float]]
) -> tuple[list[dict[str, Any]], int]:
    """Write the held-out board, whose coordinate half is the permit registry's 시군구 centroid.

    A row whose 시군구 has no centroid is DROPPED rather than written without one: the JP scorer
    compares a resolved pair against a coordinate, and a board row with none cannot be scored.
    """
    board_records: list[dict[str, Any]] = []
    without_centroid = 0
    with (out_dir / "kr-board.jsonl").open("w", encoding="utf-8") as handle:
        for row in board:
            record = encoder.encode(row)
            centroid = centroids.get(unit_key(row.region, row.sigungu))
            if centroid is None:
                without_centroid += 1
                continue
            board_records.append(record)
            handle.write(
                json.dumps(
                    {
                        "raw": record["raw"],
                        "span_starts": record["span_starts"],
                        "span_ends": record["span_ends"],
                        "span_tags": record["span_tags"],
                        "register": record["register"],
                        "region": row.region,
                        "city": row.sigungu,
                        "district": row.parenthetical,
                        "street": row.road,
                        "number": row.number,
                        "postcode": row.postcode,
                        "lon": centroid[0],
                        "lat": centroid[1],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    (out_dir / "kr-sigungu-centroids.json").write_text(
        json.dumps(centroids, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return board_records, without_centroid


def check_no_leak(train: list[LabelRow], val: list[LabelRow], board: list[LabelRow]) -> set[str]:
    """The held-out 시군구 must appear in neither trained split. Returns the board's units."""
    pool_units = {unit_key(row.region, row.sigungu) for row in train} | {
        unit_key(row.region, row.sigungu) for row in val
    }
    board_units = {unit_key(row.region, row.sigungu) for row in board}
    overlap = pool_units & board_units
    if overlap:
        raise RuntimeError(f"board 시군구 leak into train/val: {sorted(overlap)[:5]}")
    return board_units


def select_registry_rows(
    permit_dir: Path, args: argparse.Namespace, rng: random.Random, survey: RegisterSurvey, permits: PermitSurvey
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Counter[str]]:
    """Pass 4: exact selection of the aligned permit rows, and the registry board the rest feeds."""
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    registry_selector = select_exact(permits.registry_pool, args.registry_rows, rng)
    board_selector = select_exact(permits.registry_board_pool + permits.unaligned_pool, args.registry_board_rows, rng)
    registry_rows: list[dict[str, Any]] = []
    registry_board: list[dict[str, Any]] = []
    register_counts: Counter[str] = Counter()
    for permit in registers.iter_permit_rows(permit_dir, pattern=args.permit_glob):
        aligned = permit_alignment(permit, survey.index)
        point = (permit.x, permit.y) if permit.x is not None and permit.y is not None else None
        if aligned:
            unit = unit_key(aligned[0].region, aligned[0].sigungu)
            held_out = muni_bucket(unit) >= args.board_bucket_min
            for item in aligned:
                if held_out:
                    if next(board_selector):
                        registry_board.append(
                            {
                                "raw": item.raw,
                                "span_starts": item.span_starts,
                                "span_ends": item.span_ends,
                                "span_tags": item.span_tags,
                                "register": item.register,
                                "aligned": True,
                                "category": permit.category,
                                "xy": point,
                            }
                        )
                elif next(registry_selector):
                    record = registry_record(item)
                    verify_record(record, tag_set)
                    register_counts[item.register] += 1
                    registry_rows.append(record)
        elif permit.road_address or permit.lot_address:
            if next(board_selector):
                registry_board.append(
                    {
                        "raw": permit.road_address or permit.lot_address,
                        "lot_raw": permit.lot_address,
                        "aligned": False,
                        "category": permit.category,
                        "xy": point,
                    }
                )
    rng.shuffle(registry_rows)
    return registry_rows, registry_board, register_counts


def write_registry(
    registry_dir: Path, args: argparse.Namespace, rows: list[dict[str, Any]], board: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Write the registry corpus and its board, projecting the board's coordinates in one batch."""
    registry_val = max(1, int(len(rows) * args.registry_val_fraction))
    splits: dict[str, dict[str, Any]] = {}
    for split, split_rows in (("train", rows[registry_val:]), ("val", rows[:registry_val])):
        (registry_dir / split).mkdir(parents=True, exist_ok=True)
        part = 0
        for start in range(0, len(split_rows), args.rows_per_part):
            chunk = split_rows[start : start + args.rows_per_part]
            pq.write_table(
                pa.Table.from_pylist(chunk, schema=SCHEMA), registry_dir / split / f"kr-registry-{part:04d}.parquet"
            )
            part += 1
        splits[split] = {
            "rows": len(split_rows),
            "parts": part,
            "coverage": coverage_stats(split_rows[: args.stats_sample_per_part]),
        }
        print(f"registry {split}: {len(split_rows):,} rows in {part} parts")

    projected = registers.transform_coordinates([entry["xy"] for entry in board if entry["xy"] is not None])
    cursor = 0
    with (registry_dir / "kr-registry-board.jsonl").open("w", encoding="utf-8") as handle:
        for entry in board:
            if entry["xy"] is not None:
                point = projected[cursor]
                cursor += 1
                entry["lon"], entry["lat"] = (point[0], point[1]) if point else (None, None)
            entry.pop("xy", None)
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return splits


def _sealed_vocab(directory: Path, name: str) -> dict[str, int]:
    """One char vocab per corpus, sealed from that corpus's own train split."""

    def raws() -> Iterator[str]:
        for path in sorted((directory / "train").glob("*.parquet")):
            yield from pq.read_table(path, columns=["raw"])["raw"].to_pylist()

    vocab = build_char_vocab(raws(), min_count=2)
    save_char_vocab(vocab, directory / name)
    return vocab


def build(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    juso_zip = Path(args.juso_zip)
    permit_dir = Path(args.permit_dir)
    out_dir = Path(args.out_dir)
    registry_dir = Path(args.registry_out_dir)
    for directory in (out_dir, registry_dir):
        if directory.exists() and any(directory.iterdir()) and not args.force:
            raise SystemExit(
                f"{directory} exists and is non-empty — pass --force to overwrite (a slice is a read-only artifact)"
            )

    survey = survey_register(juso_zip, args)
    permits = survey_permits(permit_dir, args, survey.index)
    train_source, val_source, board = select_register_rows(juso_zip, args, rng, survey)

    encoder = LabelEncoder(args, rng, tag_set)
    splits = write_label_splits(out_dir, args, train_source, val_source, encoder)
    board_records, board_without_centroid = write_label_board(out_dir, board, encoder, permits.centroids)
    board_units = check_no_leak(train_source, val_source, board)

    registry_rows, registry_board, registry_registers = select_registry_rows(permit_dir, args, rng, survey, permits)
    registry_splits = write_registry(registry_dir, args, registry_rows, registry_board)

    vocab = _sealed_vocab(out_dir, "char-vocab-kr.json")
    registry_vocab = _sealed_vocab(registry_dir, "char-vocab-kr-registry.json")

    report = {
        "seed": args.seed,
        "juso_zip": str(juso_zip),
        "permit_dir": str(permit_dir),
        "label_set": LABEL_SET_NAME,
        "source": SOURCE,
        "registry_source": REGISTRY_SOURCE,
        "eligible_rows_scanned": survey.scanned,
        "dropped_at_source": dict(survey.dropped.most_common()),
        "per_region_cap": survey.cap,
        "regions_train": len({row.region for row in train_source}),
        "board_bucket_min": args.board_bucket_min,
        "board_sigungu": len(board_units),
        "board_rows": len(board_records),
        "board_rows_without_centroid": board_without_centroid,
        "registers": dict(encoder.register_counts.most_common()),
        "char_vocab_size": len(vocab),
        "centroid_units": len(permits.centroids),
        "fractions": {"country": args.country_fraction},
        "register_weights": REGISTER_WEIGHTS,
        "splits": splits,
        "board_coverage": coverage_stats(board_records),
        "registry": {
            "alignment_census": {
                "per_form": dict(permits.census_form),
                "per_category": {k: dict(v) for k, v in permits.census_category.items()},
            },
            "pool": {
                "aligned": permits.registry_pool,
                "held_out": permits.registry_board_pool,
                "unaligned": permits.unaligned_pool,
            },
            "registers": dict(registry_registers.most_common()),
            "splits": registry_splits,
            "board_rows": len(registry_board),
            "char_vocab_size": len(registry_vocab),
        },
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (registry_dir / "build-report.json").write_text(json.dumps(report["registry"], ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "registry"}, ensure_ascii=False, indent=2))
    print(
        json.dumps(
            {key: value for key, value in report["registry"].items() if key != "alignment_census"},
            ensure_ascii=False,
            indent=2,
        )
    )
    print(json.dumps(report["registry"]["alignment_census"]["per_form"], ensure_ascii=False))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", maxsplit=1)[0])
    parser.add_argument("--juso-zip", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(JUSO_ZIP_PARTS))
    parser.add_argument(
        "--permit-dir", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(PERMIT_DIR_PARTS)
    )
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--registry-out-dir", required=True)
    parser.add_argument("--train-rows", type=int, default=2_000_000)
    parser.add_argument("--val-rows", type=int, default=20_000)
    parser.add_argument("--board-rows", type=int, default=20_000)
    parser.add_argument("--registry-rows", type=int, default=600_000)
    parser.add_argument("--registry-val-fraction", type=float, default=0.02)
    parser.add_argument("--registry-board-rows", type=int, default=20_000)
    parser.add_argument("--board-bucket-min", type=int, default=BOARD_BUCKET_MIN)
    parser.add_argument("--rows-per-part", type=int, default=250_000)
    parser.add_argument("--stats-sample-per-part", type=int, default=50_000)
    parser.add_argument("--country-fraction", type=float, default=0.05)
    parser.add_argument("--max-field-chars", type=int, default=MAX_FIELD_CHARS)
    parser.add_argument(
        "--max-rows-per-region", type=int, default=None, help="smoke builds: read this many register rows per region"
    )
    parser.add_argument(
        "--permit-glob", default="*.csv", help="smoke builds: the permit category files to read (a glob)"
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true", help="overwrite a non-empty output directory")
    args = parser.parse_args(argv)
    args.juso_zip = resolve_data_root_default(args.juso_zip, *JUSO_ZIP_PARTS)
    args.permit_dir = resolve_data_root_default(args.permit_dir, *PERMIT_DIR_PARTS)
    return args


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))
