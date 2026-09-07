"""The Korean permit registry (지방행정인허가데이터) as a NOISY corpus source: reading and aligning (#2204 §5).

Every permit row carries the same premises in both address systems, typed by a clerk:

    도로명주소  서울특별시 종로구 종로 233, 1층 일부호 (종로5가)
    지번주소    서울특별시 종로구 종로5가 43-1

plus a planar coordinate in EPSG:5174 and both postcodes. The road-name form is `<시도> <시군구> <도로명> <건물번호>`,
then an optional `, <상세주소>` (floor, unit, building) and an optional parenthetical `(<법정동>[, <건물명>])`; the
lot-number form is `<시도> <시군구> <법정동> [<리>] [산]<본번>[-<부번>]` followed by whatever the clerk added.

Alignment is exact against the LABEL register's own key sets (`KeyIndex`, built from the 주소DB): the region must be
a listed 시도, the 시군구 one the region lists, the road one that 시군구 lists, and the number a building number.
A string that satisfies the whole key becomes a training row whose spans are the matched pieces; one that does not is
a BOARD row — a typed address the model will be read on, never trained on. The alignment rate per file is measured
and reported before any row enters a corpus, which is the rule `.notes/data-sources.md` sets for a noisy source.

The coordinate transform shells out to GDAL's `gdaltransform` in bulk (EPSG:5174 → EPSG:4326), the one tool on the
host that knows the Korean 1985 datum; PROJ's answer for Jongno's 197993.9 / 452032.96 is 126.978080 / 37.570582.
"""

from __future__ import annotations

import csv
import io
import re
import subprocess
from collections import Counter
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SOURCE = "localdata-kr"
COUNTRY = "KR"
OPEN_STATUS = "영업/정상"

_BUILDING_NUMBER = re.compile(r"^(?:지하\s?)?\d+(?:-\d+)?$")
_LOT_NUMBER = re.compile(r"^산?\d+(?:-\d+)?(?:번지)?$")
_UNIT_TOKEN = re.compile(r"^(?:지하\s?)?(?:B?\d+(?:~\d+)?(?:층|호)|\d+층|B\d+|지하\d*층?|\d+동|[가-힣]?\d*호)(?:,)?$")


@dataclass
class KeyIndex:
    """The LABEL register's key sets, the only thing a permit string is allowed to align against."""

    regions: set[str]
    sigungu_by_region: dict[str, set[str]]
    roads_by_unit: dict[tuple[str, str], set[str]]
    dongs_by_unit: dict[tuple[str, str], set[str]]
    ris_by_dong: dict[tuple[str, str, str], set[str]] = field(default_factory=dict)

    def sigungu_span(self, region: str, tokens: Sequence[str], start: int) -> int:
        """How many tokens from `start` form one of the region's 시군구 (2 for `수원시 장안구`), or 0."""
        candidates = self.sigungu_by_region.get(region, set())
        for width in (2, 1):
            if start + width <= len(tokens) and " ".join(tokens[start : start + width]) in candidates:
                return width
        return 0


@dataclass
class PermitRow:
    category: str
    name: str
    status: str
    road_address: str
    lot_address: str
    road_postcode: str
    lot_postcode: str
    x: float | None
    y: float | None


@dataclass
class Aligned:
    raw: str
    span_starts: list[int]
    span_ends: list[int]
    span_tags: list[str]
    register: str
    region: str
    sigungu: str


def iter_permit_rows(source_dir: Path, statuses: Iterable[str] = (OPEN_STATUS,)) -> Iterator[PermitRow]:
    """Stream the permit CSVs (CP949 as delivered), one `PermitRow` per business in one of `statuses`."""
    wanted = set(statuses)
    for path in sorted(source_dir.glob("*.csv")):
        with path.open("rb") as raw:
            text = io.TextIOWrapper(raw, encoding="cp949", errors="replace", newline="")
            reader = csv.DictReader(text)
            for row in reader:
                status = (row.get("영업상태명") or "").strip()
                if wanted and status not in wanted:
                    continue
                road = (row.get("도로명주소") or row.get("도로명전체주소") or "").strip()
                lot = (row.get("지번주소") or row.get("소재지전체주소") or "").strip()
                if not road and not lot:
                    continue
                x, y = (
                    row.get("좌표정보(X)") or row.get("좌표정보(x)"),
                    row.get("좌표정보(Y)") or row.get("좌표정보(y)"),
                )
                yield PermitRow(
                    category=path.stem,
                    name=(row.get("사업장명") or "").strip(),
                    status=status,
                    road_address=road,
                    lot_address=lot,
                    road_postcode=(row.get("도로명우편번호") or "").strip(),
                    lot_postcode=(row.get("소재지우편번호") or "").strip(),
                    x=float(x) if x and x.strip() else None,
                    y=float(y) if y and y.strip() else None,
                )


def transform_coordinates(points: Sequence[tuple[float, float]]) -> list[tuple[float, float] | None]:
    """EPSG:5174 planar (x, y) → WGS84 (lon, lat) through `gdaltransform`, one process per call."""
    if not points:
        return []
    payload = "\n".join(f"{x} {y}" for x, y in points) + "\n"
    result = subprocess.run(
        ["gdaltransform", "-s_srs", "EPSG:5174", "-t_srs", "EPSG:4326", "-output_xy"],
        input=payload,
        capture_output=True,
        text=True,
        check=True,
    )
    out: list[tuple[float, float] | None] = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 2:
            out.append(None)
            continue
        lon, lat = float(parts[0]), float(parts[1])
        # Korea's bounding box; a point outside it is a mis-keyed source coordinate, not a location.
        out.append((lon, lat) if 124.0 <= lon <= 132.0 and 33.0 <= lat <= 39.5 else None)
    if len(out) != len(points):
        raise RuntimeError(f"gdaltransform answered {len(out)} lines for {len(points)} points")
    return out


def _put(spans: list[tuple[int, int, str]], text: str, start: int, end: int, tag: str) -> None:
    if end > start and text[start:end].strip():
        spans.append((start, end, tag))


def align_road_address(text: str, index: KeyIndex) -> Aligned | None:
    """Align one road-name string to the register's key, or answer None."""
    head, _, tail = text.partition("(")
    parenthetical = tail[:-1].strip() if tail.endswith(")") else ""
    core, _, detail = head.partition(",")
    tokens = core.split()
    positions: list[int] = []
    cursor = 0
    for token in tokens:
        at = text.find(token, cursor)
        positions.append(at)
        cursor = at + len(token)
    if len(tokens) < 4 or tokens[0] not in index.regions:
        return None
    region = tokens[0]
    width = index.sigungu_span(region, tokens, 1)
    if not width:
        return None
    sigungu = " ".join(tokens[1 : 1 + width])
    road_at = 1 + width
    roads = index.roads_by_unit.get((region, sigungu), set())
    # A road name is one token; a numbered branch (`대학로8길`) is part of that token in the register.
    if road_at + 1 >= len(tokens) or tokens[road_at] not in roads:
        return None
    number = tokens[road_at + 1]
    if not _BUILDING_NUMBER.match(number):
        return None
    if len(tokens) > road_at + 2:
        return None
    spans: list[tuple[int, int, str]] = []
    _put(spans, text, positions[0], positions[0] + len(region), "region")
    for offset in range(width):
        token = tokens[1 + offset]
        _put(spans, text, positions[1 + offset], positions[1 + offset] + len(token), "subregion")
    _put(spans, text, positions[road_at], positions[road_at] + len(tokens[road_at]), "street")
    number_at = positions[road_at + 1]
    _put(spans, text, number_at, number_at + len(number), "house_number")
    detail = detail.strip()
    if detail:
        detail_at = text.find(detail, number_at + len(number))
        _put(spans, text, detail_at, detail_at + len(detail), "unit")
    if parenthetical:
        paren_at = text.find(parenthetical, len(head))
        dong, _, building = parenthetical.partition(",")
        dong, building = dong.strip(), building.strip()
        if dong in index.dongs_by_unit.get((region, sigungu), set()):
            dong_at = text.find(dong, paren_at)
            _put(spans, text, dong_at, dong_at + len(dong), "dependent_locality")
            if building:
                building_at = text.find(building, dong_at + len(dong))
                _put(spans, text, building_at, building_at + len(building), "venue")
        else:
            _put(spans, text, paren_at, paren_at + len(parenthetical), "venue")
    spans.sort()
    return Aligned(
        raw=text,
        span_starts=[s for s, _, _ in spans],
        span_ends=[e for _, e, _ in spans],
        span_tags=[t for _, _, t in spans],
        register="registry_road",
        region=region,
        sigungu=sigungu,
    )


def align_lot_address(text: str, index: KeyIndex) -> Aligned | None:
    """Align one lot-number string to the register's key, or answer None."""
    tokens = text.split()
    positions: list[int] = []
    cursor = 0
    for token in tokens:
        at = text.find(token, cursor)
        positions.append(at)
        cursor = at + len(token)
    if len(tokens) < 4 or tokens[0] not in index.regions:
        return None
    region = tokens[0]
    width = index.sigungu_span(region, tokens, 1)
    if not width:
        return None
    sigungu = " ".join(tokens[1 : 1 + width])
    dong_at = 1 + width
    dongs = index.dongs_by_unit.get((region, sigungu), set())
    if dong_at >= len(tokens) or tokens[dong_at] not in dongs:
        return None
    dong = tokens[dong_at]
    lot_at = dong_at + 1
    ri: str | None = None
    if lot_at < len(tokens) and tokens[lot_at] in index.ris_by_dong.get((region, sigungu, dong), set()):
        ri = tokens[lot_at]
        lot_at += 1
    if lot_at >= len(tokens) or not _LOT_NUMBER.match(tokens[lot_at]):
        return None
    lot = tokens[lot_at]
    spans: list[tuple[int, int, str]] = []
    _put(spans, text, positions[0], positions[0] + len(region), "region")
    for offset in range(width):
        token = tokens[1 + offset]
        _put(spans, text, positions[1 + offset], positions[1 + offset] + len(token), "subregion")
    _put(spans, text, positions[dong_at], positions[dong_at] + len(dong), "dependent_locality")
    if ri:
        _put(spans, text, positions[lot_at - 1], positions[lot_at - 1] + len(ri), "dependent_locality")
    _put(spans, text, positions[lot_at], positions[lot_at] + len(lot), "house_number")
    rest = tokens[lot_at + 1 :]
    if rest:
        venue_tokens = [
            (positions[lot_at + 1 + i], token) for i, token in enumerate(rest) if not _UNIT_TOKEN.match(token)
        ]
        unit_tokens = [(positions[lot_at + 1 + i], token) for i, token in enumerate(rest) if _UNIT_TOKEN.match(token)]
        if venue_tokens:
            start, end = venue_tokens[0][0], venue_tokens[-1][0] + len(venue_tokens[-1][1])
            _put(spans, text, start, end, "venue")
        if unit_tokens:
            start, end = unit_tokens[0][0], unit_tokens[-1][0] + len(unit_tokens[-1][1])
            _put(spans, text, start, end, "unit")
    spans.sort()
    return Aligned(
        raw=text,
        span_starts=[s for s, _, _ in spans],
        span_ends=[e for _, e, _ in spans],
        span_tags=[t for _, _, t in spans],
        register="registry_lot",
        region=region,
        sigungu=sigungu,
    )


def to_record(aligned: Aligned) -> dict[str, Any]:
    """One aligned string as a row in the CJK slice schema."""
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


def alignment_census(rows: Iterable[PermitRow], index: KeyIndex) -> dict[str, Any]:
    """The rate the noisy source aligns at, per form and per category, measured before any row trains."""
    per_form: Counter[str] = Counter()
    per_category: dict[str, Counter[str]] = {}
    for row in rows:
        bucket = per_category.setdefault(row.category, Counter())
        for form, text, aligner in (
            ("road", row.road_address, align_road_address),
            ("lot", row.lot_address, align_lot_address),
        ):
            if not text:
                per_form[f"{form}_empty"] += 1
                bucket[f"{form}_empty"] += 1
                continue
            outcome = "aligned" if aligner(text, index) else "unaligned"
            per_form[f"{form}_{outcome}"] += 1
            bucket[f"{form}_{outcome}"] += 1
    return {"per_form": dict(per_form), "per_category": {k: dict(v) for k, v in per_category.items()}}
