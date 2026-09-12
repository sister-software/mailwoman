"""Build the Taiwanese training corpus for the character-path CJK model from Overture-TW (#2204 §2).

Source: ``$MAILWOMAN_DATA_ROOT/overture/2026-06-17.0/addresses-tw.parquet`` — 9,732,009 rows, every one with
three ``address_levels`` (縣市 / 鄉鎮市區 / 村里), a ``street`` that already carries the section, lane and alley
(``建國路三段``, ``文建街２０１巷``), a ``number`` (``２９８`` or ``２０１號``) and a ``unit`` that holds the
sub-number and the floor (``之１號``, ``四樓``, ``四樓之２``). The rows come from the civil-affairs bureaus of 15
of Taiwan's 22 縣市 through OpenAddresses (CC BY 4.0), redistributed by Overture under CDLA-Permissive-2.0; the
build report lists the 15 agencies from the parquet's ``sources.dataset`` column, which the model card carries
because the Taiwanese license voids the grant on a missing attribution.

Measured over a 1,486,679-row sample (12 of the row groups): street ends in 巷 33%, 路 23%, 街 16%, 段 13%, 弄 12%;
``number`` is ``N號`` in 89% and a bare ``N`` in 11%; ``unit`` is empty in 39%, a sub-number ``之N號`` in 6%, a floor
(``三樓`` … ``七樓``) or a floor plus sub-number in the rest. No row carries a postcode (Chunghwa Post's 3+3 codes
carry no distribution grant, so none is built here either).

Labels, under the ``stage3-cjk`` head with NO new tag, mirroring the Korean choice of one tag per WOF placetype:

    縣市      → region              (WOF ``region``, 22 of 22 keyed)
    鄉鎮市區  → subregion           (WOF ``county`` for 234 of them, ``localadmin`` for 111 — the resolver ladder reads both)
    村里      → dependent_locality
    street    → street              (路 / 段 / 巷 / 弄 stay INSIDE the span: they are the street's own name)
    number + 之N sub-number → house_number, with the 號 designator inside the span (``298之1號``)
    floor     → unit                (``四樓``, ``四樓之2``)

Registers (weights renormalized over what a row can render; the build report says what landed):

    official     高雄市鳳山區忠義里中山西路２９８之１號       the household-registration form: full-width digits, the 里 present
    no_village   高雄市鳳山區中山西路298之1號               how it is typed: no 里, ASCII digits
    spaced       高雄市 鳳山區 中山西路 298之1號             the same with spaces between the units
    no_region    鳳山區中山西路298之1號                     the 縣市 dropped, the district carrying the row
    with_unit    高雄市鳳山區中山西路298之1號四樓            the floor appended (only rows that have one)

Held-out 鄉鎮市區 (the board) are chosen by the same stable hash rule as the JP and KR boards, at the KR share
(``--board-bucket-min 90``, about one district in ten); train and val are stratified over the 縣市 by water-filling.
The board carries the row's own coordinate; a per-district centroid table (mean of every source row) is written
beside it so the JP scorer reads the coordinate half with ``--resolve-tags region,subregion``.

Usage:
    python -m mailwoman_train.build_tw_slice --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-tw-<date>
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .char_tokenizer import build_char_vocab, save_char_vocab
from .corpora.builder import (
    MAX_FIELD_CHARS,
    SCHEMA,
    RowRenderer,
    coverage_stats,
    muni_bucket,
    select_exact,
    water_fill,
)
from .corpora.builder import verify_record as _verify_record
from .labels import resolve_label_set
from .text.normalize import ascii_digits, fullwidth_digits, normalize_text

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
DEFAULT_PARQUET = Path(DATA_ROOT) / "overture" / "2026-06-17.0" / "addresses-tw.parquet"
LABEL_SET_NAME = "stage3-cjk"
SOURCE = "overture-tw"
COUNTRY = "TW"
COUNTRY_NAMES = ("台灣", "臺灣")
BOARD_BUCKET_MIN = 90

REGISTER_WEIGHTS: dict[str, float] = {
    "official": 0.25,
    "no_village": 0.35,
    "spaced": 0.15,
    "no_region": 0.10,
    "with_unit": 0.15,
}

# The sub-number the source keeps in ``unit``: 之N, 之N附N, with or without the 號 designator, then the rest (a floor).
_SUB_NUMBER = re.compile(r"^(之[0-9０-９]+(?:附[0-9０-９]+)?號?)(.*)$")

SourceRow = tuple[str, str, str, str, str, str, float, float]
"""(region, district, village, street, house_number, unit, lon, lat) — house_number already carries the sub-number."""


def verify_record(record: dict[str, Any], tag_set: frozenset[str]) -> None:
    """The shared verifier bound to this corpus's label set."""
    _verify_record(record, tag_set, label_set_name=LABEL_SET_NAME)


def split_number_unit(number: str, unit: str) -> tuple[str, str]:
    """Fold the sub-number the source keeps in ``unit`` into the house number; what remains is the floor.

    ``("２９８", "之１號")`` → ``("２９８之１號", "")``; ``("２０１號", "四樓")`` → ``("２０１號", "四樓")``;
    ``("１４", "之１附１號")`` → ``("１４之１附１號", "")``; ``("１５２號", "四樓之２")`` → ``("１５２號", "四樓之２")``.
    A number that already ends in 號 keeps a following ``之N`` as its own continuation only when the unit carries
    nothing else, because ``201號之2`` is the written form of that address.
    """
    match = _SUB_NUMBER.match(unit)
    if not match:
        return number, unit
    sub, rest = match.group(1), match.group(2)
    if number.endswith("號"):
        if rest:
            return number, unit
        return number + sub, ""
    return number + sub, rest


def render_row(
    *,
    region: str,
    district: str,
    village: str,
    street: str,
    house_number: str,
    unit: str,
    register: str,
    country: bool = False,
) -> dict[str, Any]:
    """Render one TW row in one register, returning the slice record (spans, legacy tokens, provenance)."""
    renderer = RowRenderer()
    sep = " " if register == "spaced" else ""
    digits = fullwidth_digits if register == "official" else ascii_digits

    if country:
        renderer.put("country", COUNTRY_NAMES[0])
        renderer.glue(sep)
    if register != "no_region":
        renderer.put("region", region)
        renderer.glue(sep)
    renderer.put("subregion", district)
    renderer.glue(sep)
    if register == "official" and village:
        renderer.put("dependent_locality", village)
        renderer.glue(sep)
    renderer.put("street", digits(street))
    renderer.glue(sep)
    renderer.put("house_number", digits(house_number))
    if register == "with_unit" and unit:
        renderer.glue(sep)
        renderer.put("unit", digits(unit))

    raw = renderer.raw
    tokens: list[str] = []
    labels: list[str] = []
    cursor = 0
    for token in raw.split():
        index = raw.find(token, cursor)
        cursor = index + len(token)
        label = "O"
        for start, end, tag in zip(renderer.starts, renderer.ends, renderer.tags, strict=True):
            if start <= index < end:
                label = f"B-{tag}"
                break
        tokens.append(token)
        labels.append(label)

    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels,
        "span_starts": renderer.starts,
        "span_ends": renderer.ends,
        "span_tags": renderer.tags,
        "country": COUNTRY,
        "source": SOURCE,
        "register": register,
    }


def available_registers(village: str, unit: str) -> tuple[str, ...]:
    """The registers a row can render: ``official`` needs a 里, ``with_unit`` a floor."""
    options = [name for name in REGISTER_WEIGHTS if name not in ("official", "with_unit")]
    if village:
        options.insert(0, "official")
    if unit:
        options.append("with_unit")
    return tuple(name for name in REGISTER_WEIGHTS if name in options)


def choose_register(rng: random.Random, options: Sequence[str]) -> str:
    if len(options) == 1:
        return options[0]
    return rng.choices(options, weights=[REGISTER_WEIGHTS[name] for name in options], k=1)[0]


def iter_source_rows(
    parquet: Path,
    max_row_groups: int | None = None,
    max_field_chars: int = MAX_FIELD_CHARS,
    dropped: Counter[str] | None = None,
    agencies: Counter[str] | None = None,
) -> Iterator[SourceRow]:
    """Stream eligible rows: three levels present, a street and a number, no field over the renderer's budget."""
    handle = pq.ParquetFile(parquet)
    groups = (
        handle.metadata.num_row_groups
        if max_row_groups is None
        else min(max_row_groups, handle.metadata.num_row_groups)
    )
    columns = ["address_levels", "street", "number", "unit", "lon", "lat", "sources"]
    for index in range(groups):
        table = handle.read_row_group(index, columns=columns)
        rows = table.to_pylist()
        for row in rows:
            levels = [entry["value"] or "" for entry in (row["address_levels"] or [])]
            if len(levels) < 3 or not levels[0] or not levels[1]:
                if dropped is not None:
                    dropped["levels"] += 1
                continue
            street = normalize_text(row["street"] or "")
            number = normalize_text(row["number"] or "")
            unit = normalize_text(row["unit"] or "")
            if not street or not number:
                if dropped is not None:
                    dropped["empty"] += 1
                continue
            region, district, village = normalize_text(levels[0]), normalize_text(levels[1]), normalize_text(levels[2])
            house_number, floor = split_number_unit(number, unit)
            if any(len(value) > max_field_chars for value in (region, district, village, street, house_number, floor)):
                if dropped is not None:
                    dropped["field_too_long"] += 1
                continue
            if agencies is not None:
                for source in row["sources"] or []:
                    if source.get("dataset"):
                        agencies[source["dataset"]] += 1
            yield (region, district, village, street, house_number, floor, float(row["lon"]), float(row["lat"]))


def build(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    parquet = Path(args.parquet)

    # --- Pass 1: exact eligible counts per 縣市 + board pool + per-district centroid sums + the agency list.
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

    # --- Pass 2: exact selection, streamed.
    selectors = {region: select_exact(pool_counts[region], quotas[region], rng) for region in pool_counts}
    board_selector = select_exact(board_count, args.board_rows, rng)
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
    train_source = selected[: args.train_rows]
    val_source = selected[args.train_rows : args.train_rows + args.val_rows]
    register_counts: Counter[str] = Counter()

    def encode_one(row: SourceRow) -> dict[str, Any]:
        region, district, village, street, house_number, unit, _lon, _lat = row
        register = choose_register(rng, available_registers(village, unit))
        register_counts[register] += 1
        record = render_row(
            region=region,
            district=district,
            village=village,
            street=street,
            house_number=house_number,
            unit=unit,
            register=register,
            country=rng.random() < args.country_fraction,
        )
        verify_record(record, tag_set)
        return record

    out_dir = Path(args.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise SystemExit(
            f"{out_dir} exists and is non-empty — pass --force to overwrite (a slice is a read-only artifact)"
        )

    splits: dict[str, dict[str, Any]] = {}
    for split, source_rows in (("train", train_source), ("val", val_source)):
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        stats_input: list[dict[str, Any]] = []
        part = written = 0
        for start in range(0, len(source_rows), args.rows_per_part):
            chunk = [encode_one(row) for row in source_rows[start : start + args.rows_per_part]]
            pq.write_table(pa.Table.from_pylist(chunk, schema=SCHEMA), out_dir / split / f"tw-part-{part:04d}.parquet")
            part += 1
            written += len(chunk)
            stats_input.extend(chunk[: args.stats_sample_per_part])
        splits[split] = {"rows": written, "parts": part, "coverage": coverage_stats(stats_input)}
        print(f"{split}: {written:,} rows in {part} parts")

    # --- Held-out board: every row carries its coordinate and its routing fields.
    board_records: list[dict[str, Any]] = []
    with (out_dir / "tw-board.jsonl").open("w", encoding="utf-8") as handle:
        for row in board:
            region, district, village, street, house_number, unit, lon, lat = row
            record = encode_one(row)
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

    # --- Sanity checks. Violations RAISE; a slice that fails one is not a slice.
    pool_units = {normalize_text(f"{row[0]}|{row[1]}") for row in train_source} | {
        normalize_text(f"{row[0]}|{row[1]}") for row in val_source
    }
    board_units = {normalize_text(f"{row[0]}|{row[1]}") for row in board}
    overlap = pool_units & board_units
    if overlap:
        raise RuntimeError(f"board 鄉鎮市區 leak into train/val: {sorted(overlap)[:5]}")

    centroids = {key: [sums[0] / sums[2], sums[1] / sums[2]] for key, sums in centroid_sums.items() if sums[2]}
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
        "attribution": dict(agencies.most_common()),
        "eligible_rows_scanned": scanned,
        "dropped_at_source": dict(dropped.most_common()),
        "per_region_cap": cap,
        "regions_train": len({row[0] for row in train_source}),
        "board_bucket_min": args.board_bucket_min,
        "board_districts": len(board_units),
        "board_rows": len(board_records),
        "registers": dict(register_counts.most_common()),
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
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", maxsplit=1)[0])
    parser.add_argument("--parquet", default=str(DEFAULT_PARQUET))
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
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
