"""The National Tax Agency's corporate-number register (法人番号公表サイト 全件データ) as a NOISY corpus source (#2204 §5).

The nationwide CSV carries 30 columns per corporation; the address is FIELDED into three — 国内所在地 as 都道府県,
市区町村 and 丁目番地等 — plus a seven-digit 郵便番号. The first two are register names and align to the Overture-JP
admin ladder by exact lookup; the third is the typed part (``柏木町４－７``, ``沖見町２丁目``, ``霞が関３丁目１番１号``,
``末広町１８４ ビル名 ３Ｆ``): full-width digits and hyphens, the chōme as kanji or full-width digits, then a number in
whichever register the filer used, then a building name and floor.

Alignment: the (prefecture, municipality) pair must be one Overture keys, and the leading name of 丁目番地等 must be
a district that municipality lists. Spans are then placed on the RAW string — nothing is normalized, because the
whole value of a noisy row is the surface a person typed — with the JP head's own tags: ``prefecture``,
``municipality``, ``district``, ``block`` for a trailing 丁目, ``house_number`` for the number in its typed form
(designator forms ``N番N号`` are left whole under ``house_number`` here: splitting them into ``sub_block`` /
``building_number`` is the LABEL builder's synthesis, and a typed row is not re-rendered), ``building_name`` for
the rest, and ``postcode`` when the register carries one and the row is rendered with a 〒 prefix.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from .build_jp_slice import JP_PREFECTURES, normalize_name, split_street

SOURCE = "houjin-jp"
COUNTRY = "JP"

# Column positions in the nationwide CSV (リソース定義書 4.1: 1-based 1 sequence, 2 法人番号, 7 商号, 9 法人種別,
# 10 都道府県, 11 市区町村, 12 丁目番地等, 16 郵便番号).
COL_NAME = 6
COL_KIND = 8
COL_PREFECTURE = 9
COL_MUNICIPALITY = 10
COL_STREET = 11
COL_POSTCODE = 15

_DIGITS = "0-9０-９"
_KANJI_NUMERAL = "〇一二三四五六七八九十百"
_HYPHENS = "-－‐‑‒–—―−ー﹘﹣ｰ"
# The numeric tail of 丁目番地等: an optional chōme, then a number in either register, then whatever follows.
_TAIL_SHAPE = re.compile(
    rf"^(?P<chome>[{_DIGITS}{_KANJI_NUMERAL}]+丁目)?"
    rf"(?P<number>(?:[{_DIGITS}]+(?:番地?|号)?)(?:[{_HYPHENS}][{_DIGITS}]+(?:番地?|号)?)*)?"
    rf"(?P<rest>.*)$"
)
_TAIL_START = re.compile(rf"[{_DIGITS}{_KANJI_NUMERAL}]")


def split_typed_street(street: str, districts: set[str]) -> tuple[str, str, str, str] | None:
    """Split ``丁目番地等`` into (district, chōme, number, rest) at the leftmost split point whose district the register lists.

    A district name may itself carry a kanji numeral (``一条通北２丁目３－２５``), so the split point is not "the first
    numeral": every numeral position is tried left to right, and the first whose prefix is a listed district and
    whose tail parses as chōme-then-number wins. Answers None when no split point does.
    """
    for match in _TAIL_START.finditer(street):
        boundary = match.start()
        district = street[:boundary]
        if not district or normalize_name(district) not in districts:
            continue
        tail = _TAIL_SHAPE.match(street[boundary:])
        if not tail:
            continue
        chome, number = tail.group("chome") or "", tail.group("number") or ""
        if not chome and not number:
            continue
        return district, chome, number, tail.group("rest") or ""
    return None


@dataclass
class JPKeyIndex:
    """(prefecture, municipality) → the districts Overture lists under it, from the same parquet the LABEL corpus reads."""

    districts_by_unit: dict[tuple[str, str], set[str]] = field(default_factory=dict)

    @classmethod
    def from_parquet(cls, parquet: Path, max_row_groups: int | None = None) -> JPKeyIndex:
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
                if not level or len(level) < 2 or not street:
                    continue
                prefecture, municipality = level[0]["value"], level[1]["value"]
                if prefecture not in JP_PREFECTURES or not municipality:
                    continue
                district, _chome = split_street(normalize_name(street))
                if district:
                    index.districts_by_unit.setdefault((prefecture, municipality), set()).add(district)
        return index


@dataclass
class CorporateRow:
    name: str
    kind: str
    prefecture: str
    municipality: str
    street: str
    postcode: str


def iter_corporate_rows(zip_path: Path) -> Iterator[CorporateRow]:
    """Stream the nationwide CSV out of its zip: one row per corporation with a domestic address."""
    with zipfile.ZipFile(zip_path) as archive:
        member = next(info.filename for info in archive.infolist() if info.filename.endswith(".csv"))
        with archive.open(member) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
            for row in csv.reader(text):
                if len(row) <= COL_POSTCODE:
                    continue
                prefecture, municipality, street = row[COL_PREFECTURE], row[COL_MUNICIPALITY], row[COL_STREET]
                if not prefecture or not municipality or not street:
                    continue
                yield CorporateRow(
                    name=row[COL_NAME],
                    kind=row[COL_KIND],
                    prefecture=prefecture,
                    municipality=municipality,
                    street=street,
                    postcode=row[COL_POSTCODE],
                )


@dataclass
class Aligned:
    raw: str
    span_starts: list[int]
    span_ends: list[int]
    span_tags: list[str]
    register: str
    prefecture: str
    municipality: str


def align_corporate_row(row: CorporateRow, index: JPKeyIndex, with_postcode: bool = False) -> Aligned | None:
    """Render the three fields as the one line a person types and place spans on it, or answer None."""
    districts = index.districts_by_unit.get((row.prefecture, row.municipality))
    if not districts:
        return None
    street = "".join(row.street.split())
    split = split_typed_street(street, districts)
    if split is None:
        return None
    district, chome, number, rest = split
    spans: list[tuple[int, int, str]] = []
    raw = ""
    if with_postcode and len(row.postcode) == 7 and row.postcode.isdigit():
        raw += "〒"
        code = f"{row.postcode[:3]}-{row.postcode[3:]}"
        spans.append((len(raw), len(raw) + len(code), "postcode"))
        raw += code + " "
    spans.append((len(raw), len(raw) + len(row.prefecture), "prefecture"))
    raw += row.prefecture
    spans.append((len(raw), len(raw) + len(row.municipality), "municipality"))
    raw += row.municipality
    spans.append((len(raw), len(raw) + len(district), "district"))
    raw += district
    if chome:
        spans.append((len(raw), len(raw) + len(chome), "block"))
        raw += chome
    if number:
        spans.append((len(raw), len(raw) + len(number), "house_number"))
        raw += number
    if rest:
        building = rest.strip()
        if building:
            spans.append((len(raw), len(raw) + len(building), "building_name"))
            raw += building
    return Aligned(
        raw=raw,
        span_starts=[s for s, _, _ in spans],
        span_ends=[e for _, e, _ in spans],
        span_tags=[t for _, _, t in spans],
        register="registry",
        prefecture=row.prefecture,
        municipality=row.municipality,
    )


def to_record(aligned: Aligned) -> dict[str, Any]:
    raw = aligned.raw
    tokens: list[str] = []
    labels: list[str] = []
    cursor = 0
    for token in raw.split():
        index = raw.find(token, cursor)
        cursor = index + len(token)
        label = "O"
        for start, end, tag in zip(aligned.span_starts, aligned.span_ends, aligned.span_tags, strict=True):
            if start <= index < end:
                label = f"B-{tag}"
                break
        tokens.append(token)
        labels.append(label)
    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels,
        "span_starts": list(aligned.span_starts),
        "span_ends": list(aligned.span_ends),
        "span_tags": list(aligned.span_tags),
        "country": COUNTRY,
        "source": SOURCE,
        "register": aligned.register,
    }


def alignment_census(rows: Iterable[CorporateRow], index: JPKeyIndex) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for row in rows:
        counts["aligned" if align_corporate_row(row, index) else "unaligned"] += 1
    return dict(counts)
