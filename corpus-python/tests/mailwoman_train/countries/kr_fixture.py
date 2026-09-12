"""The 주소DB and the permit registry in the shapes the readers expect, at a size a test can build.

The portal delivers pipe-delimited CP949 text inside a ZIP whose member names are CP949 bytes
WITHOUT the UTF-8 flag, and CP949 CSVs for the permits. Every one of those is a place a reader can
be wrong in a way a UTF-8 fixture would never show, so the fixture meets the real encoding rather
than a convenient one.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass, field
from pathlib import Path


class CP949MemberInfo(zipfile.ZipInfo):
    """A member whose name is stored as CP949 bytes WITHOUT the UTF-8 flag, the way the portal writes them. `zipfile`
    itself always stores a non-ASCII name as UTF-8 with the flag, so a reader test needs this to meet the real shape."""

    def _encodeFilenameFlags(self) -> tuple[bytes, int]:  # noqa: N802 — zipfile's own hook name
        return self.filename.encode("cp949"), self.flag_bits


@dataclass(frozen=True)
class JusoAddress:
    """One address across the three per-region files, keyed by the id they share."""

    address_id: str
    main: str
    sub: str = "0000"
    postcode: str = "03047"
    dong: str = ""
    ri: str = ""
    lot_main: str = "0052"
    lot_sub: str = "0001"
    building: str = ""


@dataclass(frozen=True)
class JusoRegion:
    """One 시도: its road-code row plus the addresses written against that road."""

    region: str
    sigungu: str
    eupmyeondong: str
    road: str
    road_code: str
    serial: str
    #: 도로명코드's 읍면동구분: "0" is an 읍/면 the road address itself carries, "1" a 동.
    kind: str
    lot_code: str
    addresses: list[JusoAddress] = field(default_factory=list)


def _members(region: JusoRegion) -> tuple[str, str, str]:
    """The 주소 / 지번 / 부가정보 text for one region, at the column positions the reader indexes."""
    addresses = "\n".join(
        f"{row.address_id}|{region.road_code}|{region.serial}|0|{row.main}|{row.sub}|{row.postcode}|0|20140101||1"
        for row in region.addresses
    )
    lots = "\n".join(
        f"{row.address_id}|1|{region.lot_code}|{region.region}|{region.sigungu}|{row.dong}|{row.ri}|0|"
        f"{row.lot_main}|{row.lot_sub}|1"
        for row in region.addresses
    )
    supplements = "\n".join(
        f"{row.address_id}|{region.lot_code}|{region.eupmyeondong}|{row.postcode}|001||{row.building}||0"
        for row in region.addresses
    )
    return addresses, lots, supplements


def write_juso_zip(path: Path, regions: list[JusoRegion]) -> None:
    """An edition of the 주소DB in the portal's shape: CP949 members named without the UTF-8 flag.

    The portal ships ONE file per 시도, so entries sharing a 시도 name — several 시군구 of one
    province — are concatenated into that province's member rather than overwriting it.
    """
    road_codes = "\n".join(
        f"{region.road_code}|{region.road}|Road|{region.serial}|{region.region}|Sido|{region.sigungu}|Sigungu|"
        f"{region.eupmyeondong}|Eupmyeondong|{region.kind}|{region.lot_code}|1"
        for region in regions
    )
    by_sido: dict[str, list[tuple[str, str, str]]] = {}
    for region in regions:
        by_sido.setdefault(region.region, []).append(_members(region))

    members = {"개선_도로명코드_전체분.txt": road_codes}
    for sido, blocks in by_sido.items():
        for prefix, column in (("주소", 0), ("지번", 1), ("부가정보", 2)):
            members[f"{prefix}_{sido}.txt"] = "\n".join(block[column] for block in blocks)

    with zipfile.ZipFile(path, "w") as archive:
        for name, text in members.items():
            archive.writestr(CP949MemberInfo(name), text.encode("cp949"))


#: The census row the register tests read: a 동 area, so the parenthetical is the 법정동.
SEOUL = JusoRegion(
    region="서울특별시",
    sigungu="종로구",
    eupmyeondong="청운효자동",
    road="자하문로",
    road_code="111104100001",
    serial="01",
    kind="1",
    lot_code="1111010100",
    addresses=[JusoAddress(address_id="11110000000001", main="00094", dong="청운동", building="청운빌딩")],
)

#: An 읍/면 area: the road address carries the 면 and the parenthetical is the 리.
GANGWON = JusoRegion(
    region="강원특별자치도",
    sigungu="원주시",
    eupmyeondong="신림면",
    road="신림황둔로",
    road_code="511304100002",
    serial="02",
    kind="0",
    lot_code="5113035000",
    addresses=[
        JusoAddress(
            address_id="51130000000002",
            main="00011",
            postcode="26301",
            ri="신림리",
            lot_main="0668",
            lot_sub="0013",
        )
    ],
)

PERMIT_COLUMNS = (
    "사업장명",
    "영업상태명",
    "도로명주소",
    "지번주소",
    "도로명우편번호",
    "소재지우편번호",
    "좌표정보(X)",
    "좌표정보(Y)",
)


def write_permit_csv(path: Path, rows: list[tuple[str, str, str, str, str, str, str, str]]) -> None:
    """One permit category as the portal delivers it: a CP949 CSV under the category's own filename."""
    lines = [",".join(PERMIT_COLUMNS), *[",".join(row) for row in rows]]
    path.write_bytes(("\r\n".join(lines) + "\r\n").encode("cp949"))
