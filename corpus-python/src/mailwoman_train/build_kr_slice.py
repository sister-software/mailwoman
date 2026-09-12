"""Build the Korean training corpus for the character-path CJK model from the road-name address register (#2204 §1, §5).

Two sources, two output corpora, one label set (``stage3-cjk``, no new tag):

**The LABEL corpus** (``--out-dir``, source ``juso-kr``) renders the ministry's 주소DB — 6,424,089 road-name addresses
with their representative lot, postcode and building name (`kr_juso.py`) — in seven registers:

    official        서울특별시 종로구 자하문로 94 (청운동)             the register's own form, the 법정동 (or 리) in parentheses
    building        서울특별시 종로구 송월길 99 (홍파동, 경희궁자이)   the official form with the building name after the 동
    no_dong         서울특별시 종로구 자하문로 94                     how it is typed
    postcode_first  03047 서울특별시 종로구 자하문로 94               the delivery form
    short_region    서울시 종로구 자하문로 94                         the spoken region (서울 / 경기 / 충북 …)
    unspaced        서울특별시종로구자하문로94                         a search box, no spaces
    jibun           서울특별시 종로구 청운동 52-1                     the lot-number form, still the one half of Korea writes

    REGION → region, 시군구 → subregion (two adjacent spans for `수원시 장안구`), 읍/면 and 법정동/리 → dependent_locality,
    road → street, building number and lot number → house_number, postcode → postcode, building name → venue.

**The registry corpus** (``--registry-out-dir``, source ``localdata-kr``) is the NOISY half: every open business in
the permit registry (`kr_registry.py`), each row carrying both address forms as a clerk typed them, aligned against
the LABEL register's own key sets and kept only when the whole key matches. The alignment rate is measured per form
and per category and written to the build report BEFORE the rows are selected. A permit string that does not align
is a board row (``kr-registry-board.jsonl``), never a training row.

The board is the held-out set of 시군구 (the same stable hash rule as the JP and TW boards, one in ten). The register
carries no coordinate, so the board's coordinate half is the permit registry's: every permit row's EPSG:5174 point is
projected through GDAL and averaged per 시군구, and the LABEL board row carries its 시군구's centroid, which is what
the JP scorer compares a resolved (region, subregion) pair against. Permit rows in a held-out 시군구 go to the
registry board, so a typed address in a held-out district is read, not trained.

Usage:
    python -m mailwoman_train.build_kr_slice \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-kr-<date> \\
        --registry-out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-kr-registry-<date>
"""

from __future__ import annotations

import argparse
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

from .build_cjk_overlay import verify_cn_record as verify_record
from .corpora.builder import (
    MAX_FIELD_CHARS,
    MAX_RENDERED_CHARS,
    SCHEMA,
    RowRenderer,
    coverage_stats,
    muni_bucket,
    select_exact,
    water_fill,
)
from .kr_juso import REGION_ALIASES, LabelRow, alias_key_index, empty_key_index, index_label_row, iter_label_rows
from .kr_registry import (
    Aligned,
    KeyIndex,
    PermitRow,
    align_lot_address,
    align_road_address,
    iter_permit_rows,
    to_record,
    transform_coordinates,
)
from .labels import resolve_label_set
from .text.normalize import normalize_text
from .tokenizer.char import build_char_vocab, save_char_vocab

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
DEFAULT_JUSO_ZIP = Path(DATA_ROOT) / "corpus" / "sources" / "juso-kr" / "202608ALLMTCHG00.zip"
DEFAULT_PERMIT_DIR = Path(DATA_ROOT) / "corpus" / "sources" / "localdata-kr"
LABEL_SET_NAME = "stage3-cjk"
SOURCE = "juso-kr"
REGISTRY_SOURCE = "localdata-kr"
COUNTRY = "KR"
COUNTRY_NAME = "대한민국"
BOARD_BUCKET_MIN = 90

# The spoken / typed short forms of the 시·도. A region absent here has no `short_region` register; the build report
# counts the rows that lose the register rather than inventing a form.
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
    "official": 0.22,
    "building": 0.08,
    "no_dong": 0.20,
    "postcode_first": 0.10,
    "short_region": 0.10,
    "unspaced": 0.08,
    "jibun": 0.22,
}


def render_row(
    row: LabelRow,
    *,
    register: str,
    country: bool = False,
    short_region: str | None = None,
) -> dict[str, Any]:
    """Render one LABEL row in one register, returning the slice record (spans, legacy tokens, provenance)."""
    renderer = RowRenderer()
    sep = "" if register == "unspaced" else " "

    if register == "postcode_first":
        renderer.put("postcode", row.postcode)
        renderer.glue(" ")
    if country:
        renderer.put("country", COUNTRY_NAME)
        renderer.glue(sep)
    if register == "short_region":
        if not short_region:
            raise ValueError("short_region register needs a short region form")
        renderer.put("region", short_region)
    else:
        renderer.put("region", row.region)
    renderer.glue(sep)
    # A compound 시군구 (`수원시 장안구`) is two adjacent subregion spans; the space between them is glue. 세종특별자치시
    # has no 시군구 at all, so its rows go straight from the region to the 읍/면 or the road.
    for index, unit in enumerate(row.sigungu.split()):
        if index:
            renderer.glue(sep)
        renderer.put("subregion", unit)
    if row.sigungu:
        renderer.glue(sep)

    if register == "jibun":
        renderer.put("dependent_locality", row.dong)
        if row.ri:
            renderer.glue(sep)
            renderer.put("dependent_locality", row.ri)
        renderer.glue(sep)
        renderer.put("house_number", row.lot)
        if row.building:
            renderer.glue(sep)
            renderer.put("venue", row.building)
    else:
        if row.eupmyeon:
            renderer.put("dependent_locality", row.eupmyeon)
            renderer.glue(sep)
        renderer.put("street", row.road)
        renderer.glue(sep)
        if row.underground:
            renderer.glue("지하 ")
        renderer.put("house_number", row.number)
        if register in ("official", "building") and row.parenthetical:
            renderer.glue(" (")
            renderer.put("dependent_locality", row.parenthetical)
            if register == "building" and row.building:
                renderer.glue(", ")
                renderer.put("venue", row.building)
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


def available_registers(row: LabelRow) -> tuple[str, ...]:
    """The registers a row can render: `short_region` needs a known short form, `official`/`building` a parenthetical,
    `building` a building name, `jibun` a lot with its 동."""
    options = {"no_dong", "postcode_first", "unspaced"}
    if row.parenthetical:
        options.add("official")
        if row.building:
            options.add("building")
    if row.region in SHORT_REGIONS:
        options.add("short_region")
    if row.dong and row.lot:
        options.add("jibun")
    return tuple(name for name in REGISTER_WEIGHTS if name in options)


def choose_register(rng: random.Random, options: Sequence[str]) -> str:
    if len(options) == 1:
        return options[0]
    return rng.choices(options, weights=[REGISTER_WEIGHTS[name] for name in options], k=1)[0]


def choose_short_region(rng: random.Random, region: str) -> str | None:
    forms = SHORT_REGIONS.get(region)
    return rng.choice(forms) if forms else None


def eligible(row: LabelRow, max_field_chars: int) -> str | None:
    """The reason a register row is dropped, or None when it renders."""
    # 시군구 is not required: 세종특별자치시 has none.
    if not (row.region and row.road and row.number and row.postcode):
        return "missing_field"
    if any(len(value) > max_field_chars for value in (row.region, row.sigungu, row.road, row.number, row.building)):
        return "field_too_long"
    if row.sigungu.count(" ") > 1 or " " in row.road or " " in row.number:
        return "whitespace_shape"
    return None


def unit_key(region: str, sigungu: str) -> str:
    """The centroid / hold-out key: the register's current region name, so a pre-merger permit row keys the same unit."""
    return normalize_text(f"{REGION_ALIASES.get(region, region)}|{sigungu}")


def registry_record(aligned: Aligned) -> dict[str, Any]:
    record = to_record(aligned)
    record["source"] = REGISTRY_SOURCE
    return record


def permit_alignment(row: PermitRow, index: KeyIndex) -> list[Aligned]:
    """Every form of one permit row that aligns AND fits the model's window: a clerk's 99-character unit list
    (`1층 282,283,292,293,302,303호 (…, 샤크존빌딩 A226~228,…)`) would be truncated by the loader, so it is a board row."""
    out: list[Aligned] = []
    if row.road_address:
        road = align_road_address(row.road_address, index)
        if road and len(road.raw) <= MAX_RENDERED_CHARS:
            out.append(road)
    if row.lot_address:
        lot = align_lot_address(row.lot_address, index)
        if lot and len(lot.raw) <= MAX_RENDERED_CHARS:
            out.append(lot)
    return out


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

    # --- Pass 1 over the register: eligible counts per region, the board pool, the key index.
    index = empty_key_index()
    pool_counts: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    board_count = scanned = 0
    for row in iter_label_rows(juso_zip, args.max_rows_per_region):
        reason = eligible(row, args.max_field_chars)
        if reason:
            dropped[reason] += 1
            continue
        scanned += 1
        index_label_row(index, row)
        if muni_bucket(unit_key(row.region, row.sigungu)) >= args.board_bucket_min:
            board_count += 1
        else:
            pool_counts[row.region] += 1
    alias_key_index(index)
    print(f"pass 1: {scanned:,} eligible register rows · {len(pool_counts)} regions · board pool {board_count:,}")
    print(
        f"pass 1: dropped {dict(dropped)} · key index {len(index.regions)} regions, {sum(len(v) for v in index.roads_by_unit.values()):,} (unit, road) keys"
    )
    drop_rate = sum(dropped.values()) / max(scanned + sum(dropped.values()), 1)
    if drop_rate > 0.02:
        raise RuntimeError(
            f"register drop rate {drop_rate:.4f} exceeds 2% — the eligibility filter no longer fits the data"
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

    # --- Pass 2 over the permits: the alignment census, the centroid sums, the registry pool.
    census_form: Counter[str] = Counter()
    census_category: dict[str, Counter[str]] = {}
    centroid_sums: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    registry_pool = 0
    registry_board_pool = 0
    unaligned_pool = 0
    permit_points: list[tuple[float, float]] = []
    permit_units: list[str] = []

    def flush_points() -> None:
        for point, key in zip(transform_coordinates(permit_points), permit_units, strict=True):
            if point is None:
                continue
            sums = centroid_sums[key]
            sums[0] += point[0]
            sums[1] += point[1]
            sums[2] += 1
        permit_points.clear()
        permit_units.clear()

    for permit in iter_permit_rows(permit_dir, pattern=args.permit_glob):
        bucket = census_category.setdefault(permit.category, Counter())
        aligned = permit_alignment(permit, index)
        forms = {"road": permit.road_address, "lot": permit.lot_address}
        by_register = {item.register: item for item in aligned}
        for form, text in forms.items():
            key = "empty" if not text else ("aligned" if f"registry_{form}" in by_register else "unaligned")
            census_form[f"{form}_{key}"] += 1
            bucket[f"{form}_{key}"] += 1
        if aligned:
            unit = unit_key(aligned[0].region, aligned[0].sigungu)
            if permit.x is not None and permit.y is not None:
                permit_points.append((permit.x, permit.y))
                permit_units.append(unit)
                if len(permit_points) >= 200_000:
                    flush_points()
            if muni_bucket(unit) >= args.board_bucket_min:
                registry_board_pool += len(aligned)
            else:
                registry_pool += len(aligned)
        elif permit.road_address or permit.lot_address:
            unaligned_pool += 1
    flush_points()
    centroids = {key: [sums[0] / sums[2], sums[1] / sums[2]] for key, sums in centroid_sums.items() if sums[2]}
    print(
        f"pass 2: permits aligned — {dict(census_form)} · registry pool {registry_pool:,} · held-out {registry_board_pool:,} · unaligned {unaligned_pool:,} · centroids {len(centroids)}"
    )

    # --- Pass 3 over the register: exact selection, streamed.
    selectors = {region: select_exact(pool_counts[region], quotas[region], rng) for region in pool_counts}
    board_selector = select_exact(board_count, args.board_rows, rng)
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
    train_source = selected[: args.train_rows]
    val_source = selected[args.train_rows : args.train_rows + args.val_rows]
    register_counts: Counter[str] = Counter()

    def encode_one(row: LabelRow) -> dict[str, Any]:
        register = choose_register(rng, available_registers(row))
        register_counts[register] += 1
        record = render_row(
            row,
            register=register,
            country=rng.random() < args.country_fraction,
            short_region=choose_short_region(rng, row.region),
        )
        verify_record(record, tag_set)
        return record

    splits: dict[str, dict[str, Any]] = {}
    for split, source_rows in (("train", train_source), ("val", val_source)):
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        stats_input: list[dict[str, Any]] = []
        part = written = 0
        for start in range(0, len(source_rows), args.rows_per_part):
            chunk = [encode_one(row) for row in source_rows[start : start + args.rows_per_part]]
            pq.write_table(pa.Table.from_pylist(chunk, schema=SCHEMA), out_dir / split / f"kr-part-{part:04d}.parquet")
            part += 1
            written += len(chunk)
            stats_input.extend(chunk[: args.stats_sample_per_part])
        splits[split] = {"rows": written, "parts": part, "coverage": coverage_stats(stats_input)}
        print(f"{split}: {written:,} rows in {part} parts")

    # --- The LABEL board: held-out 시군구, the coordinate half from the permit centroids.
    board_records: list[dict[str, Any]] = []
    board_without_centroid = 0
    with (out_dir / "kr-board.jsonl").open("w", encoding="utf-8") as handle:
        for row in board:
            record = encode_one(row)
            centroid = centroids.get(unit_key(row.region, row.sigungu))
            if centroid is None:
                board_without_centroid += 1
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

    pool_units = {unit_key(row.region, row.sigungu) for row in train_source} | {
        unit_key(row.region, row.sigungu) for row in val_source
    }
    board_units = {unit_key(row.region, row.sigungu) for row in board}
    overlap = pool_units & board_units
    if overlap:
        raise RuntimeError(f"board 시군구 leak into train/val: {sorted(overlap)[:5]}")

    # --- Pass 4 over the permits: exact selection of the registry rows, the registry board.
    registry_selector = select_exact(registry_pool, args.registry_rows, rng)
    registry_board_selector = select_exact(registry_board_pool + unaligned_pool, args.registry_board_rows, rng)
    registry_rows: list[dict[str, Any]] = []
    registry_board: list[dict[str, Any]] = []
    registry_registers: Counter[str] = Counter()
    for permit in iter_permit_rows(permit_dir, pattern=args.permit_glob):
        aligned = permit_alignment(permit, index)
        point = (permit.x, permit.y) if permit.x is not None and permit.y is not None else None
        if aligned:
            unit = unit_key(aligned[0].region, aligned[0].sigungu)
            held_out = muni_bucket(unit) >= args.board_bucket_min
            for item in aligned:
                if held_out:
                    if next(registry_board_selector):
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
                    registry_registers[item.register] += 1
                    registry_rows.append(record)
        elif permit.road_address or permit.lot_address:
            if next(registry_board_selector):
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
    registry_val = max(1, int(len(registry_rows) * args.registry_val_fraction))
    registry_splits: dict[str, dict[str, Any]] = {}
    for split, rows in (("train", registry_rows[registry_val:]), ("val", registry_rows[:registry_val])):
        (registry_dir / split).mkdir(parents=True, exist_ok=True)
        part = 0
        for start in range(0, len(rows), args.rows_per_part):
            chunk = rows[start : start + args.rows_per_part]
            pq.write_table(
                pa.Table.from_pylist(chunk, schema=SCHEMA), registry_dir / split / f"kr-registry-{part:04d}.parquet"
            )
            part += 1
        registry_splits[split] = {
            "rows": len(rows),
            "parts": part,
            "coverage": coverage_stats(rows[: args.stats_sample_per_part]),
        }
        print(f"registry {split}: {len(rows):,} rows in {part} parts")

    # The registry board's coordinates, projected in one batch.
    points = [entry["xy"] for entry in registry_board]
    projected = transform_coordinates([p for p in points if p is not None])
    cursor = 0
    with (registry_dir / "kr-registry-board.jsonl").open("w", encoding="utf-8") as handle:
        for entry in registry_board:
            if entry["xy"] is not None:
                point = projected[cursor]
                cursor += 1
                entry["lon"], entry["lat"] = (point[0], point[1]) if point else (None, None)
            entry.pop("xy", None)
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # --- Vocabularies: one per corpus, both sealed from their own train split.
    def raws(directory: Path) -> Iterator[str]:
        for path in sorted((directory / "train").glob("*.parquet")):
            yield from pq.read_table(path, columns=["raw"])["raw"].to_pylist()

    vocab = build_char_vocab(raws(out_dir), min_count=2)
    save_char_vocab(vocab, out_dir / "char-vocab-kr.json")
    registry_vocab = build_char_vocab(raws(registry_dir), min_count=2)
    save_char_vocab(registry_vocab, registry_dir / "char-vocab-kr-registry.json")

    report = {
        "seed": args.seed,
        "juso_zip": str(juso_zip),
        "permit_dir": str(permit_dir),
        "label_set": LABEL_SET_NAME,
        "source": SOURCE,
        "registry_source": REGISTRY_SOURCE,
        "eligible_rows_scanned": scanned,
        "dropped_at_source": dict(dropped.most_common()),
        "per_region_cap": cap,
        "regions_train": len({row.region for row in train_source}),
        "board_bucket_min": args.board_bucket_min,
        "board_sigungu": len(board_units),
        "board_rows": len(board_records),
        "board_rows_without_centroid": board_without_centroid,
        "registers": dict(register_counts.most_common()),
        "char_vocab_size": len(vocab),
        "centroid_units": len(centroids),
        "fractions": {"country": args.country_fraction},
        "register_weights": REGISTER_WEIGHTS,
        "splits": splits,
        "board_coverage": coverage_stats(board_records),
        "registry": {
            "alignment_census": {
                "per_form": dict(census_form),
                "per_category": {k: dict(v) for k, v in census_category.items()},
            },
            "pool": {"aligned": registry_pool, "held_out": registry_board_pool, "unaligned": unaligned_pool},
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
    parser.add_argument("--juso-zip", default=str(DEFAULT_JUSO_ZIP))
    parser.add_argument("--permit-dir", default=str(DEFAULT_PERMIT_DIR))
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
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
