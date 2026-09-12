"""Rendering one Korean address in one of seven registers, and deciding which a row can render.

A register is a way the same address gets written: the ministry's own form, the typed form, the
delivery form, the spoken short region, a search box with no spaces, the lot-number form. A row
does not always support all seven — `short_region` needs a known short form, `official` and
`building` need the parenthetical, `jibun` needs a lot with its 동 — so `available_registers`
answers what is honestly renderable and the build report counts what landed.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from typing import Any

from ....corpora.builder import MAX_RENDERED_CHARS, RowRenderer
from ....text.normalize import normalize_text
from ..juso import REGION_ALIASES, LabelRow
from ..registers import Aligned, KeyIndex, PermitRow, align_lot_address, align_road_address, to_record

LABEL_SET_NAME = "stage3-cjk"
SOURCE = "juso-kr"
REGISTRY_SOURCE = "localdata-kr"
COUNTRY = "KR"
COUNTRY_NAME = "대한민국"

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
