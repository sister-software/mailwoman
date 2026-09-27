from __future__ import annotations

import random
import re
from collections import Counter
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from ....corpora.builder import MAX_FIELD_CHARS, RowRenderer
from ....corpora.builder import verify_record as _verify_record
from ....text.normalize import ascii_digits, fullwidth_digits, normalize_text

PARQUET_PARTS = ("overture", "2026-06-17.0", "addresses-tw.parquet")
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


_SUB_NUMBER = re.compile(r"^(之[0-9０-９]+(?:附[0-9０-９]+)?號?)(.*)$")

SourceRow = tuple[str, str, str, str, str, str, float, float]
"""(region, district, village, street, house_number, unit, lon, lat) — house_number already carries the sub-number."""


def verify_record(record: dict[str, Any], tag_set: frozenset[str]) -> None:
    _verify_record(record, tag_set, label_set_name=LABEL_SET_NAME)


def split_number_unit(number: str, unit: str) -> tuple[str, str]:
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
