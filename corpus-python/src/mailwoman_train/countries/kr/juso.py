"""The Korean road-name address register (주소DB) as the LABEL source: a streaming reader over the monthly zip (#2204 §1).

The zip the portal serves (``202608ALLMTCHG00.zip``) holds four pipe-delimited CP949 text files per 시도 plus one
nationwide road-code file, laid out as the guide inside the zip states (붙임1, the 전체분 layout):

    개선_도로명코드_전체분.txt   도로명코드|도로명|도로명로마자|읍면동일련번호|시도명|시도로마자|시군구명|시군구로마자|읍면동명|읍면동로마자|읍면동구분|읍면동코드|사용여부|…
    주소_<시도>.txt              관리번호|도로명코드|읍면동일련번호|지하여부|건물본번|건물부번|기초구역번호|변경사유코드|고시일자|변경전도로명주소|상세주소부여여부
    지번_<시도>.txt              관리번호|일련번호|법정동코드|시도명|시군구명|법정읍면동명|법정리명|산여부|지번본번|지번부번|대표여부
    부가정보_<시도>.txt          관리번호|행정동코드|행정동명|우편번호|우편번호일련번호|다량배달처명|건축물대장건물명|시군구건물명|공동주택여부

A LABEL row is one 주소 record joined to its road code (the admin ladder and the road name), its representative
lot (대표여부 = 1: the 법정동, the 리, and the lot number the 지번 form writes) and its supplement (the postcode — the
기초구역번호 on the 주소 row IS the five-digit postcode — and the building name). The row count note in the zip gives
6,424,089 addresses and 8,194,643 lots for the 2026-08-31 edition.

The 2026 edition writes the merged 전남광주통합특별시 where every older source (the permit registry, Who's On First)
still writes 전라남도 and 광주광역시; `REGION_ALIASES` maps the older names onto the register's so a typed string in
either form aligns.
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .registers import KeyIndex

# The road-code file's columns (0-based).
RC_CODE, RC_ROAD, RC_SERIAL, RC_REGION, RC_SIGUNGU, RC_EUPMYEONDONG, RC_KIND = 0, 1, 3, 4, 6, 8, 10
# 주소 columns.
AD_ID, AD_ROAD_CODE, AD_SERIAL, AD_UNDERGROUND, AD_MAIN, AD_SUB, AD_POSTCODE = 0, 1, 2, 3, 4, 5, 6
# 지번 columns.
LOT_ID, LOT_REGION, LOT_SIGUNGU, LOT_DONG, LOT_RI, LOT_MOUNTAIN, LOT_MAIN, LOT_SUB, LOT_PRIMARY = (
    0,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
)
# 부가정보 columns.
SUP_ID, SUP_POSTCODE, SUP_BUILDING_REGISTER, SUP_BUILDING_LOCAL, SUP_APARTMENT = 0, 3, 6, 7, 8

REGION_ALIASES: dict[str, str] = {
    "전라남도": "전남광주통합특별시",
    "광주광역시": "전남광주통합특별시",
    "강원도": "강원특별자치도",
    "전라북도": "전북특별자치도",
}


@dataclass(frozen=True)
class LabelRow:
    region: str
    sigungu: str
    # The 읍/면 the road address itself carries between the 시군구 and the road (읍면동구분 0), else empty: a 동 is
    # never written in the road form, it goes in the parenthetical.
    eupmyeon: str
    dong: str
    ri: str
    road: str
    number: str
    postcode: str
    building: str
    lot: str
    underground: bool

    @property
    def parenthetical(self) -> str:
        """What the official form writes in parentheses after the number: the 법정동 in a 동 area, the 리 in an 읍/면."""
        return self.ri if self.eupmyeon else self.dong


def member_names(archive: zipfile.ZipFile) -> dict[str, str]:
    """Readable name → the archive's own name. The portal writes CP949 names without the UTF-8 flag, which `zipfile`
    surfaces as CP437 mojibake; recoding them is the only way to find `주소_서울특별시.txt` by name."""
    names: dict[str, str] = {}
    for info in archive.infolist():
        if info.flag_bits & 0x800:
            names[info.filename] = info.filename
            continue
        try:
            names[info.filename.encode("cp437").decode("cp949")] = info.filename
        except UnicodeError:
            names[info.filename] = info.filename
    return names


def _lines(archive: zipfile.ZipFile, member: str) -> Iterator[list[str]]:
    with archive.open(member) as raw:
        for line in io.TextIOWrapper(raw, encoding="cp949", errors="replace", newline=""):
            yield line.rstrip("\r\n").split("|")


def region_members(names: dict[str, str], prefix: str) -> list[tuple[str, str]]:
    """(region suffix, archive name) for every full-edition file of one kind, sorted by region."""
    out = []
    for readable, actual in names.items():
        if readable.startswith(prefix + "_") and readable.endswith(".txt") and "변동" not in readable:
            out.append((readable[len(prefix) + 1 : -4], actual))
    return sorted(out)


def load_road_codes(
    archive: zipfile.ZipFile, names: dict[str, str]
) -> dict[tuple[str, str], tuple[str, str, str, str, str]]:
    """(도로명코드, 읍면동일련번호) → (시도명, 시군구명, 읍면동명, 도로명, 읍면동구분)."""
    codes: dict[tuple[str, str], tuple[str, str, str, str, str]] = {}
    member = next(actual for readable, actual in names.items() if "도로명코드" in readable and "변동" not in readable)
    for fields in _lines(archive, member):
        if len(fields) <= RC_KIND:
            continue
        codes[(fields[RC_CODE], fields[RC_SERIAL])] = (
            fields[RC_REGION],
            fields[RC_SIGUNGU],
            fields[RC_EUPMYEONDONG],
            fields[RC_ROAD],
            fields[RC_KIND],
        )
    return codes


def iter_label_rows(zip_path: Path, max_rows_per_region: int | None = None) -> Iterator[LabelRow]:
    """Stream every LABEL row region by region: the lot and supplement files of one 시도 are held in memory while its
    address file streams, so the join never holds the country at once."""
    with zipfile.ZipFile(zip_path) as archive:
        names = member_names(archive)
        codes = load_road_codes(archive, names)
        lot_members = dict(region_members(names, "지번"))
        supplement_members = dict(region_members(names, "부가정보"))
        for suffix, member in region_members(names, "주소"):
            lots: dict[str, tuple[str, str, str]] = {}
            for fields in _lines(archive, lot_members[suffix]):
                if len(fields) <= LOT_PRIMARY or fields[LOT_PRIMARY] != "1":
                    continue
                main, sub = fields[LOT_MAIN].lstrip("0") or "0", fields[LOT_SUB].lstrip("0")
                lot = f"{'산' if fields[LOT_MOUNTAIN] == '1' else ''}{main}{'-' + sub if sub and sub != '0' else ''}"
                lots[fields[LOT_ID]] = (fields[LOT_DONG], fields[LOT_RI], lot)
            supplements: dict[str, tuple[str, str]] = {}
            for fields in _lines(archive, supplement_members[suffix]):
                if len(fields) <= SUP_APARTMENT:
                    continue
                building = fields[SUP_BUILDING_LOCAL] or fields[SUP_BUILDING_REGISTER]
                supplements[fields[SUP_ID]] = (fields[SUP_POSTCODE], building)
            emitted = 0
            for fields in _lines(archive, member):
                if len(fields) <= AD_POSTCODE:
                    continue
                code = codes.get((fields[AD_ROAD_CODE], fields[AD_SERIAL]))
                if code is None:
                    continue
                region, sigungu, eupmyeondong, road, kind = code
                dong, ri, lot = lots.get(fields[AD_ID], ("", "", ""))
                postcode, building = supplements.get(fields[AD_ID], (fields[AD_POSTCODE], ""))
                main, sub = fields[AD_MAIN].lstrip("0") or "0", fields[AD_SUB].lstrip("0")
                number = f"{main}{'-' + sub if sub and sub != '0' else ''}"
                yield LabelRow(
                    region=region,
                    sigungu=sigungu,
                    eupmyeon=eupmyeondong if kind == "0" else "",
                    dong=dong,
                    ri=ri,
                    road=road,
                    number=number,
                    postcode=postcode or fields[AD_POSTCODE],
                    building=building,
                    lot=lot,
                    underground=fields[AD_UNDERGROUND] == "1",
                )
                emitted += 1
                if max_rows_per_region is not None and emitted >= max_rows_per_region:
                    break


def empty_key_index() -> KeyIndex:
    return KeyIndex(regions=set(), sigungu_by_region={}, roads_by_unit={}, dongs_by_unit={}, ris_by_dong={})


def index_label_row(index: KeyIndex, row: LabelRow) -> None:
    """Add one LABEL row's names to the key sets. The 읍/면 joins the road set's unit as a road-form token too, since the
    road address writes it between the 시군구 and the road."""
    index.regions.add(row.region)
    index.sigungu_by_region.setdefault(row.region, set()).add(row.sigungu)
    unit = (row.region, row.sigungu)
    index.roads_by_unit.setdefault(unit, set()).add(row.road)
    if row.eupmyeon:
        index.dongs_by_unit.setdefault(unit, set()).add(row.eupmyeon)
    if row.dong:
        index.dongs_by_unit.setdefault(unit, set()).add(row.dong)
        if row.ri:
            index.ris_by_dong.setdefault((row.region, row.sigungu, row.dong), set()).add(row.ri)


def alias_key_index(index: KeyIndex) -> None:
    """Admit the pre-merger region names as aliases of the register's current one, sharing its key sets."""
    for legacy, current in REGION_ALIASES.items():
        if current not in index.regions:
            continue
        index.regions.add(legacy)
        index.sigungu_by_region[legacy] = index.sigungu_by_region[current]
        for (region, sigungu), roads in list(index.roads_by_unit.items()):
            if region == current:
                index.roads_by_unit[(legacy, sigungu)] = roads
        for (region, sigungu), dongs in list(index.dongs_by_unit.items()):
            if region == current:
                index.dongs_by_unit[(legacy, sigungu)] = dongs
        for (region, sigungu, dong), ris in list(index.ris_by_dong.items()):
            if region == current:
                index.ris_by_dong[(legacy, sigungu, dong)] = ris


def build_key_index(rows: Iterator[LabelRow]) -> KeyIndex:
    """The key sets the permit aligner reads, from one pass over the LABEL rows; the older region names are admitted
    as aliases so a permit string written before the 2026 merger still aligns."""
    index = empty_key_index()
    for row in rows:
        index_label_row(index, row)
    alias_key_index(index)
    return index
