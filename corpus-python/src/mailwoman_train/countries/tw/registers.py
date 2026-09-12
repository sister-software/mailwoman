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

from ...text.normalize import ascii_digits, normalize_text

SOURCE = "gcis-tw"
COUNTRY = "TW"

_DIGITS = "0-9０-９"
# A sub-number is written 之N or with a dash (161-1號, 161─1號 with a box-drawing dash from a clerk's keyboard).
_SUB = rf"(?:之|[-－─‐−])[{_DIGITS}]+"
_NUMBER = re.compile(rf"^(?P<number>[{_DIGITS}]+(?:{_SUB})*(?:附[{_DIGITS}]+)?號(?:{_SUB})?)(?P<rest>.*)$")
# The floor, as the registers write it: 2樓, ２樓之１, 地下一層, B1, and any of those in parentheses.
_FLOOR = re.compile(
    rf"^[（(]?(?:(?:地下|B|Ｂ)?[{_DIGITS}一二三四五六七八九十]+(?:樓|層|F|Ｆ)(?:之[{_DIGITS}]+)?|地下室|頂樓)[）)]?$"
)
_SECTION = re.compile(rf"([{_DIGITS}]+)段")
_KANJI_SECTION = dict(enumerate("〇一二三四五六七八九十", start=0))


def _section_kanji(match: re.Match[str]) -> str:
    """``2段`` → ``二段``: Overture writes the section ordinal in kanji, the registers in digits."""
    value = int(ascii_digits(match.group(1)))
    return (_KANJI_SECTION.get(value, match.group(1))) + "段"


def fold_key(text: str) -> str:
    """The comparison key: NFC, spaces removed, ASCII digits, 台 read as 臺, a digit section ordinal read as kanji."""
    folded = ascii_digits(normalize_text(unicodedata.normalize("NFC", text))).replace("台", "臺")
    return _SECTION.sub(_section_kanji, folded)


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
        # Batches of 100,000 rows rather than whole row groups: the index is small, the transient Python lists of a
        # multi-million-row group are not, and this host has killed the build for memory once.
        for batch in handle.iter_batches(
            batch_size=100_000, columns=["address_levels", "street"], row_groups=list(range(groups))
        ):
            for level, street in zip(
                batch.column("address_levels").to_pylist(), batch.column("street").to_pylist(), strict=True
            ):
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
