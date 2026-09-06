"""Build the Korean road-name-address corpus for the character-path CJK model (#1177 Phase B, the KR spec).

Source: the OpenAddresses delivery of 도로명주소 (juso, entrance points) at
``$MAILWOMAN_DATA_ROOT/openaddresses/extracted/kr/<province>/provincewide.csv`` — 6,173,505 rows over the 17
시·도, every row carrying REGION / CITY / DISTRICT / STREET / NUMBER / POSTCODE and a WGS84 entrance point.
License KOGL Type 1 (attribution: 행정안전부).

The output is the JP slice's parquet schema (``build_jp_slice.SCHEMA``) so the CJK overlay and the trainer read it
unchanged, under the ``stage3-cjk`` label set with NO new tag:

    REGION   → region              (시·도; 17 of 17 keyed in the candidate gazetteer as WOF ``region``)
    CITY     → subregion           (시·군·구 — the 시군구 are WOF ``county``, which the resolver's ``locality`` filter
                                    group does not admit; ``subregion → county`` is already in the placetype map.
                                    A compound ``수원시 장안구`` renders as TWO adjacent subregion spans, the space
                                    between them outside both, because a span never holds whitespace.)
    DISTRICT → dependent_locality  (읍·면·동, the legal 동 the official form carries in parentheses)
    STREET   → street              NUMBER → house_number              POSTCODE → postcode

Registers (weights renormalized over what a row can render; the build report says what landed):

    official        서울특별시 종로구 자하문로 94 (청운동)      the source's own form, 동 in parentheses
    no_dong         서울특별시 종로구 자하문로 94              how it is typed
    postcode_first  03047 서울특별시 종로구 자하문로 94        the delivery form
    short_region    서울시 종로구 자하문로 94                  the spoken region (서울 / 경기 / 충북 …)
    unspaced        서울특별시종로구자하문로94                  a search box, no spaces

Held-out 시군구 (the board) are chosen by the same stable hash rule as the JP board's municipalities, at a higher
share (``--board-bucket-min 90``, about one 시군구 in ten) because there are 227 of them rather than 1,700; train and
val are stratified over the 17 regions by water-filling, exactly as the JP build stratifies over prefectures. The board
carries the entrance point; a per-시군구 centroid table (mean of every source row) is written beside it so the JP
scorer reads the coordinate half with ``--resolve-tags region,subregion``.

Usage:
    python -m mailwoman_train.build_kr_slice --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-kr-<date>
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
from collections import Counter, defaultdict
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .build_jp_slice import (
    MAX_FIELD_CHARS,
    SCHEMA,
    RowRenderer,
    coverage_stats,
    muni_bucket,
    norm_key,
    select_exact,
    verify_record,
    water_fill,
)
from .char_tokenizer import build_char_vocab, save_char_vocab
from .labels import resolve_label_set

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
DEFAULT_SOURCE_DIR = Path(DATA_ROOT) / "openaddresses" / "extracted" / "kr"
LABEL_SET_NAME = "stage3-cjk"
SOURCE = "juso-kr"
COUNTRY = "KR"
COUNTRY_NAME = "대한민국"
BOARD_BUCKET_MIN = 90

# The spoken / typed short forms of the 17 시·도. A region absent here has no `short_region` register; the build
# report counts the rows that lose the register rather than inventing a form.
SHORT_REGIONS: dict[str, tuple[str, ...]] = {
    "서울특별시": ("서울시", "서울"),
    "부산광역시": ("부산시", "부산"),
    "대구광역시": ("대구시", "대구"),
    "인천광역시": ("인천시", "인천"),
    "광주광역시": ("광주시", "광주"),
    "대전광역시": ("대전시", "대전"),
    "울산광역시": ("울산시", "울산"),
    "세종특별자치시": ("세종시", "세종"),
    "경기도": ("경기",),
    "강원도": ("강원",),
    "강원특별자치도": ("강원도", "강원"),
    "충청북도": ("충북",),
    "충청남도": ("충남",),
    "전라북도": ("전북",),
    "전북특별자치도": ("전북",),
    "전라남도": ("전남",),
    "경상북도": ("경북",),
    "경상남도": ("경남",),
    "제주특별자치도": ("제주도", "제주"),
}

REGISTER_WEIGHTS: dict[str, float] = {
    "official": 0.35,
    "no_dong": 0.25,
    "postcode_first": 0.15,
    "short_region": 0.15,
    "unspaced": 0.10,
}

SourceRow = tuple[str, str, str, str, str, str, float, float]
"""(region, city, district, street, number, postcode, lon, lat)"""


def render_row(
    *,
    region: str,
    city: str,
    district: str,
    street: str,
    number: str,
    postcode: str,
    register: str,
    country: bool = False,
    short_region: str | None = None,
) -> dict[str, Any]:
    """Render one KR row in one register, returning the slice record (spans, legacy tokens, provenance)."""
    renderer = RowRenderer()
    sep = "" if register == "unspaced" else " "

    if register == "postcode_first":
        renderer.put("postcode", postcode)
        renderer.glue(" ")
    if country:
        renderer.put("country", COUNTRY_NAME)
        renderer.glue(sep)
    if register == "short_region":
        if not short_region:
            raise ValueError("short_region register needs a short region form")
        renderer.put("region", short_region)
    else:
        renderer.put("region", region)
    renderer.glue(sep)
    # A compound 시군구 (`수원시 장안구`) is two adjacent subregion spans; the space between them is glue.
    for index, unit in enumerate(city.split()):
        if index:
            renderer.glue(sep)
        renderer.put("subregion", unit)
    if city:
        renderer.glue(sep)
    renderer.put("street", street)
    renderer.glue(sep)
    renderer.put("house_number", number)
    if register == "official" and district:
        renderer.glue(" (")
        renderer.put("dependent_locality", district)
        renderer.glue(")")

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


def available_registers(region: str, district: str) -> tuple[str, ...]:
    """The registers a row can render: `short_region` needs a known short form, `official` a 동."""
    options = [name for name in REGISTER_WEIGHTS if name not in ("short_region", "official")]
    if district:
        options.insert(0, "official")
    if region in SHORT_REGIONS:
        options.append("short_region")
    return tuple(name for name in REGISTER_WEIGHTS if name in options)


def choose_register(rng: random.Random, options: Sequence[str]) -> str:
    """Draw one register by the KR weights, renormalized over the options the row can render."""
    if len(options) == 1:
        return options[0]
    return rng.choices(options, weights=[REGISTER_WEIGHTS[name] for name in options], k=1)[0]


def choose_short_region(rng: random.Random, region: str) -> str | None:
    forms = SHORT_REGIONS.get(region)
    return rng.choice(forms) if forms else None


def source_files(source_dir: Path) -> list[Path]:
    """The per-province CSVs, by province code; the `seoul/` mirror directory is not a province."""
    return sorted(path for path in source_dir.glob("*/provincewide.csv") if path.parent.name.isdigit())


def iter_source_rows(
    source_dir: Path,
    max_field_chars: int = MAX_FIELD_CHARS,
    dropped: Counter[str] | None = None,
    max_rows_per_file: int | None = None,
) -> Iterator[SourceRow]:
    """Stream eligible rows: every routing field present, no field over the width the renderer fits in S=96."""
    for path in source_files(source_dir):
        with path.open(encoding="utf-8", newline="") as handle:
            for count, row in enumerate(csv.DictReader(handle)):
                if max_rows_per_file is not None and count >= max_rows_per_file:
                    break
                region, city, district = row["REGION"].strip(), row["CITY"].strip(), row["DISTRICT"].strip()
                street, number, postcode = row["STREET"].strip(), row["NUMBER"].strip(), row["POSTCODE"].strip()
                reason = None
                if not (region and street and number and postcode):
                    reason = "missing_field"
                elif any(len(value) > max_field_chars for value in (region, city, district, street, number)):
                    reason = "field_too_long"
                elif any(value.count(" ") > 1 for value in (city,)) or " " in street or " " in number:
                    reason = "whitespace_shape"
                if reason:
                    if dropped is not None:
                        dropped[reason] += 1
                    continue
                yield (region, city, district, street, number, postcode, float(row["LON"]), float(row["LAT"]))


def build(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    source_dir = Path(args.source_dir)

    # --- Pass 1: exact eligible counts per region + board pool + per-시군구 centroid sums. --------
    pool_counts: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    centroid_sums: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    board_count = scanned = 0
    for region, city, _district, _street, _number, _postcode, lon, lat in iter_source_rows(
        source_dir, args.max_field_chars, dropped, args.max_rows_per_file
    ):
        scanned += 1
        sums = centroid_sums[norm_key(f"{region}|{city}")]
        sums[0] += lon
        sums[1] += lat
        sums[2] += 1
        if muni_bucket(f"{region}|{city}") >= args.board_bucket_min:
            board_count += 1
        else:
            pool_counts[region] += 1
    print(f"pass 1: {scanned:,} eligible rows · {len(pool_counts)} regions · board pool {board_count:,}")
    print(f"pass 1: dropped {dict(dropped)}")
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

    # --- Pass 2: exact selection, streamed. ------------------------------------------------------
    selectors = {region: select_exact(pool_counts[region], quotas[region], rng) for region in pool_counts}
    board_selector = select_exact(board_count, args.board_rows, rng)
    selected: list[SourceRow] = []
    board: list[SourceRow] = []
    for row in iter_source_rows(source_dir, args.max_field_chars, None, args.max_rows_per_file):
        if muni_bucket(f"{row[0]}|{row[1]}") >= args.board_bucket_min:
            if next(board_selector):
                board.append(row)
        elif next(selectors[row[0]]):
            selected.append(row)
    print(f"pass 2: selected {len(selected):,} pool rows · {len(board):,} board rows")

    rng.shuffle(selected)
    train_source = selected[: args.train_rows]
    val_source = selected[args.train_rows : args.train_rows + args.val_rows]
    register_unavailable: Counter[str] = Counter()

    def encode(rows: Sequence[SourceRow]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for region, city, district, street, number, postcode, _lon, _lat in rows:
            options = available_registers(region, district)
            register_unavailable["full" if len(options) == len(REGISTER_WEIGHTS) else "reduced"] += 1
            register = choose_register(rng, options)
            record = render_row(
                region=region,
                city=city,
                district=district,
                street=street,
                number=number,
                postcode=postcode,
                register=register,
                country=rng.random() < args.country_fraction,
                short_region=choose_short_region(rng, region),
            )
            verify_record(record, tag_set)
            out.append(record)
        return out

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
            chunk = encode(source_rows[start : start + args.rows_per_part])
            pq.write_table(pa.Table.from_pylist(chunk, schema=SCHEMA), out_dir / split / f"kr-part-{part:04d}.parquet")
            part += 1
            written += len(chunk)
            stats_input.extend(chunk[: args.stats_sample_per_part])
        splits[split] = {"rows": written, "parts": part, "coverage": coverage_stats(stats_input)}
        print(f"{split}: {written:,} rows in {part} parts")

    # --- Held-out board: every row carries its entrance point and its kanji-free routing fields. --
    board_records: list[dict[str, Any]] = []
    with (out_dir / "kr-board.jsonl").open("w", encoding="utf-8") as handle:
        for region, city, district, street, number, postcode, lon, lat in board:
            register = choose_register(rng, available_registers(region, district))
            record = render_row(
                region=region,
                city=city,
                district=district,
                street=street,
                number=number,
                postcode=postcode,
                register=register,
                country=rng.random() < args.country_fraction,
                short_region=choose_short_region(rng, region),
            )
            verify_record(record, tag_set)
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
                        "city": city,
                        "district": district,
                        "street": street,
                        "number": number,
                        "postcode": postcode,
                        "lon": lon,
                        "lat": lat,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    # --- Sanity checks. Violations RAISE; a slice that fails one is not a slice. -------------------
    train_regions = {row[0] for row in train_source}
    if args.max_rows_per_file is None and len(train_regions) not in (17, len(pool_counts)):
        raise RuntimeError(f"train covers {len(train_regions)} regions, expected 17 — stratification broken")
    pool_units = {norm_key(f"{row[0]}|{row[1]}") for row in train_source} | {
        norm_key(f"{row[0]}|{row[1]}") for row in val_source
    }
    board_units = {norm_key(f"{row[0]}|{row[1]}") for row in board}
    overlap = pool_units & board_units
    if overlap:
        raise RuntimeError(f"board 시군구 leak into train/val: {sorted(overlap)[:5]}")

    centroids = {key: [sums[0] / sums[2], sums[1] / sums[2]] for key, sums in centroid_sums.items() if sums[2]}
    (out_dir / "kr-sigungu-centroids.json").write_text(
        json.dumps(centroids, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    def train_raws() -> Iterator[str]:
        for path in sorted((out_dir / "train").glob("*.parquet")):
            yield from pq.read_table(path, columns=["raw"])["raw"].to_pylist()

    vocab = build_char_vocab(train_raws(), min_count=2)
    save_char_vocab(vocab, out_dir / "char-vocab-kr.json")

    report = {
        "seed": args.seed,
        "source_dir": str(source_dir),
        "label_set": LABEL_SET_NAME,
        "source": SOURCE,
        "eligible_rows_scanned": scanned,
        "dropped_at_source": dict(dropped.most_common()),
        "per_region_cap": cap,
        "regions_train": len(train_regions),
        "board_bucket_min": args.board_bucket_min,
        "board_sigungu": len(board_units),
        "board_rows": len(board_records),
        "register_availability": dict(register_unavailable),
        "char_vocab_size": len(vocab),
        "centroid_units": len(centroids),
        "fractions": {"country": args.country_fraction},
        "register_weights": REGISTER_WEIGHTS,
        "splits": splits,
        "board_coverage": coverage_stats(board_records),
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", maxsplit=1)[0])
    parser.add_argument("--source-dir", default=str(DEFAULT_SOURCE_DIR))
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--train-rows", type=int, default=2_000_000)
    parser.add_argument("--val-rows", type=int, default=20_000)
    parser.add_argument("--board-rows", type=int, default=20_000)
    parser.add_argument("--board-bucket-min", type=int, default=BOARD_BUCKET_MIN)
    parser.add_argument("--rows-per-part", type=int, default=250_000)
    parser.add_argument("--stats-sample-per-part", type=int, default=50_000)
    parser.add_argument("--country-fraction", type=float, default=0.05)
    parser.add_argument("--max-field-chars", type=int, default=MAX_FIELD_CHARS)
    parser.add_argument(
        "--max-rows-per-file", type=int, default=None, help="smoke builds: read this many rows per province"
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true", help="overwrite a non-empty --out-dir")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
