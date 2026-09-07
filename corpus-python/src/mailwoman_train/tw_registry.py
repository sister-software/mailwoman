"""Taiwan's company and business registers (GCIS 公司登記 / 商業登記資料) as a NOISY corpus source (#2204 §5).

Each register row carries the registered address as ONE string, and the company files carry a second rendering of
the same premises from the tax office:

    公司地址  臺中市南屯區同心里文心路一段186號17樓之10
    營業地址  臺中市南屯區同心里文心路１段１８６號１７樓之１０

The shape is ``<縣市><鄉鎮市區>[<村里>]<街路 with 段/巷/弄><號><樓 之N>``, no separators, digits in either width,
臺/台 in either form, and an occasional U+3000 inside a district name (``北　區``). Alignment is exact against the
Overture-TW key sets (`TWKeyIndex`): the 縣市 must be one Overture lists, the 鄉鎮市區 one of that 縣市's, and the
street one that district lists; the number and the floor are read by the same regexes the LABEL builder uses. The
spans land on the string AS TYPED, digits and all. A string that does not satisfy the key is a board row.
"""

from __future__ import annotations

import csv
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from .build_tw_slice import ascii_digits, normalize_text

SOURCE = "gcis-tw"
COUNTRY = "TW"

_DIGITS = "0-9０-９"
_NUMBER = re.compile(
    rf"^(?P<number>[{_DIGITS}]+(?:之[{_DIGITS}]+)*(?:附[{_DIGITS}]+)?號(?:之[{_DIGITS}]+)?)(?P<rest>.*)$"
)
_FLOOR = re.compile(rf"^(?:地下)?[{_DIGITS}一二三四五六七八九十]+樓(?:之[{_DIGITS}]+)?$")


def fold_key(text: str) -> str:
    """The comparison key: NFC, spaces removed, ASCII digits, 台 read as 臺."""
    return ascii_digits(normalize_text(unicodedata.normalize("NFC", text))).replace("台", "臺")


@dataclass
class TWKeyIndex:
    regions: set[str] = field(default_factory=set)
    districts_by_region: dict[str, set[str]] = field(default_factory=dict)
    villages_by_unit: dict[tuple[str, str], set[str]] = field(default_factory=dict)
    streets_by_unit: dict[tuple[str, str], set[str]] = field(default_factory=dict)

    @classmethod
    def from_parquet(cls, parquet: Path, max_row_groups: int | None = None) -> TWKeyIndex:
        handle = pq.ParquetFile(parquet)
        groups = (
            handle.metadata.num_row_groups
            if max_row_groups is None
            else min(max_row_groups, handle.metadata.num_row_groups)
        )
        index = cls()
        for group in range(groups):
            table = handle.read_row_group(group, columns=["address_levels", "street"])
            for level, street in zip(table["address_levels"].to_pylist(), table["street"].to_pylist(), strict=True):
                if not level or len(level) < 3 or not street:
                    continue
                region, district, village = (fold_key(entry["value"] or "") for entry in level[:3])
                if not region or not district:
                    continue
                index.regions.add(region)
                index.districts_by_region.setdefault(region, set()).add(district)
                if village:
                    index.villages_by_unit.setdefault((region, district), set()).add(village)
                index.streets_by_unit.setdefault((region, district), set()).add(fold_key(street))
        return index


@dataclass
class RegisterRow:
    name: str
    address: str
    tax_address: str


def iter_register_rows(source_dir: Path) -> Iterator[RegisterRow]:
    for path in sorted(source_dir.glob("*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                address = (row.get("公司地址") or row.get("商業地址") or row.get("地址") or "").strip()
                tax = (row.get("營業地址（財政資訊中心匯入）") or "").strip()
                name = (row.get("公司名稱") or row.get("商業名稱") or "").strip()
                if address or tax:
                    yield RegisterRow(name=name, address=address, tax_address=tax)


@dataclass
class Aligned:
    raw: str
    span_starts: list[int]
    span_ends: list[int]
    span_tags: list[str]
    register: str
    region: str
    district: str


def _longest_prefix(text: str, at: int, candidates: set[str]) -> str | None:
    """The longest candidate whose folded form begins the folded text at `at`; answers the RAW substring."""
    best: str | None = None
    for width in range(2, min(12, len(text) - at) + 1):
        piece = text[at : at + width]
        if fold_key(piece) in candidates and (best is None or len(piece) > len(best)):
            best = piece
    return best


def align_register_address(text: str, index: TWKeyIndex) -> Aligned | None:
    raw = "".join(text.split())
    if not raw:
        return None
    spans: list[tuple[int, int, str]] = []
    at = 0
    region = _longest_prefix(raw, at, index.regions)
    if not region:
        return None
    spans.append((at, at + len(region), "region"))
    at += len(region)
    region_key = fold_key(region)
    district = _longest_prefix(raw, at, index.districts_by_region.get(region_key, set()))
    if not district:
        return None
    spans.append((at, at + len(district), "subregion"))
    at += len(district)
    unit = (region_key, fold_key(district))
    village = _longest_prefix(raw, at, index.villages_by_unit.get(unit, set()))
    if village:
        spans.append((at, at + len(village), "dependent_locality"))
        at += len(village)
    street = _longest_prefix(raw, at, index.streets_by_unit.get(unit, set()))
    if not street:
        return None
    spans.append((at, at + len(street), "street"))
    at += len(street)
    match = _NUMBER.match(raw[at:])
    if not match:
        return None
    number = match.group("number")
    spans.append((at, at + len(number), "house_number"))
    at += len(number)
    rest = match.group("rest")
    if rest:
        if not _FLOOR.match(rest):
            return None
        spans.append((at, at + len(rest), "unit"))
    return Aligned(
        raw=raw,
        span_starts=[s for s, _, _ in spans],
        span_ends=[e for _, e, _ in spans],
        span_tags=[t for _, _, t in spans],
        register="registry",
        region=region_key,
        district=fold_key(district),
    )


def to_record(aligned: Aligned) -> dict[str, Any]:
    raw = aligned.raw
    return {
        "raw": raw,
        "tokens": [raw],
        "labels": [f"B-{aligned.span_tags[0]}"],
        "span_starts": list(aligned.span_starts),
        "span_ends": list(aligned.span_ends),
        "span_tags": list(aligned.span_tags),
        "country": COUNTRY,
        "source": SOURCE,
        "register": aligned.register,
    }


def alignment_census(rows: Iterable[RegisterRow], index: TWKeyIndex) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for row in rows:
        for form, text in (("registered", row.address), ("tax", row.tax_address)):
            if not text:
                counts[f"{form}_empty"] += 1
                continue
            counts[f"{form}_{'aligned' if align_register_address(text, index) else 'unaligned'}"] += 1
    return dict(counts)
