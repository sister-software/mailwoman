"""The Korean corpus builder over the 주소DB: the reader's join, the seven registers, span discipline, and eligibility.

The end-to-end build is not exercised here: it needs the permit registry and `gdaltransform` for the centroid pass, and
its receipt is the build report beside the corpus it wrote. What a unit test can pin is the shape of one LABEL row and
what each register renders from it.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from mailwoman_train.corpora.builder import verify_cjk_record
from mailwoman_train.countries.kr.corpora import (
    REGISTER_WEIGHTS,
    SHORT_REGIONS,
    available_registers,
    eligible,
    render_row,
)
from mailwoman_train.countries.kr.juso import LabelRow, iter_label_rows
from mailwoman_train.labels import resolve_label_set

TAGS = frozenset(resolve_label_set("stage3-cjk").tags)


def label_row(**overrides: Any) -> LabelRow:
    """The Jongno-gu row of the census: a 동 area, so the parenthetical is the 법정동."""
    fields: dict[str, Any] = {
        "region": "서울특별시",
        "sigungu": "종로구",
        "eupmyeon": "",
        "dong": "청운동",
        "ri": "",
        "road": "자하문로",
        "number": "94",
        "postcode": "03047",
        "building": "청운빌딩",
        "lot": "52-1",
        "underground": False,
    }
    fields.update(overrides)
    return LabelRow(**fields)


def spans(record: dict[str, Any]) -> list[tuple[str, str]]:
    raw = record["raw"]
    return [
        (tag, raw[s:e])
        for s, e, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True)
    ]


def test_official_register_is_the_source_form_with_the_dong_in_parentheses() -> None:
    record = render_row(label_row(), register="official")
    assert record["raw"] == "서울특별시 종로구 자하문로 94 (청운동)"
    assert spans(record) == [
        ("region", "서울특별시"),
        ("subregion", "종로구"),
        ("street", "자하문로"),
        ("house_number", "94"),
        ("dependent_locality", "청운동"),
    ]
    verify_cjk_record(record, TAGS)


def test_building_register_adds_the_building_name_inside_the_parenthetical() -> None:
    record = render_row(label_row(), register="building")
    assert record["raw"] == "서울특별시 종로구 자하문로 94 (청운동, 청운빌딩)"
    assert spans(record)[-2:] == [("dependent_locality", "청운동"), ("venue", "청운빌딩")]
    verify_cjk_record(record, TAGS)


@pytest.mark.parametrize(
    ("register", "expected"),
    [
        ("no_dong", "서울특별시 종로구 자하문로 94"),
        ("postcode_first", "03047 서울특별시 종로구 자하문로 94"),
        ("unspaced", "서울특별시종로구자하문로94"),
    ],
)
def test_the_typed_registers(register: str, expected: str) -> None:
    record = render_row(label_row(), register=register)
    assert record["raw"] == expected
    assert "dependent_locality" not in record["span_tags"]
    verify_cjk_record(record, TAGS)


def test_jibun_register_is_the_lot_form_with_the_dong_as_dependent_locality() -> None:
    record = render_row(label_row(), register="jibun")
    assert record["raw"] == "서울특별시 종로구 청운동 52-1 청운빌딩"
    assert spans(record) == [
        ("region", "서울특별시"),
        ("subregion", "종로구"),
        ("dependent_locality", "청운동"),
        ("house_number", "52-1"),
        ("venue", "청운빌딩"),
    ]
    verify_cjk_record(record, TAGS)


def test_an_eupmyeon_row_writes_the_myeon_before_the_road_and_the_ri_in_parentheses() -> None:
    row = label_row(
        region="강원특별자치도",
        sigungu="원주시",
        eupmyeon="신림면",
        dong="신림면",
        ri="신림리",
        road="신림황둔로",
        number="11",
        lot="668-13",
        building="",
    )
    official = render_row(row, register="official")
    assert official["raw"] == "강원특별자치도 원주시 신림면 신림황둔로 11 (신림리)"
    # Two dependent_locality spans on one row: the 면 before the road and the 리 in the parenthetical. The board scorer
    # reads every same-tag span for exactly this shape.
    assert [surface for tag, surface in spans(official) if tag == "dependent_locality"] == ["신림면", "신림리"]
    jibun = render_row(row, register="jibun")
    assert jibun["raw"] == "강원특별자치도 원주시 신림면 신림리 668-13"
    assert [surface for tag, surface in spans(jibun) if tag == "dependent_locality"] == ["신림면", "신림리"]
    verify_cjk_record(official, TAGS)
    verify_cjk_record(jibun, TAGS)


def test_an_underground_number_keeps_지하_outside_the_house_number_span() -> None:
    record = render_row(label_row(underground=True), register="no_dong")
    assert record["raw"] == "서울특별시 종로구 자하문로 지하 94"
    assert ("house_number", "94") in spans(record)
    assert all("지하" not in surface for _, surface in spans(record))
    verify_cjk_record(record, TAGS)


def test_short_region_replaces_the_region_span_only() -> None:
    record = render_row(label_row(), register="short_region", short_region="서울시")
    assert record["raw"] == "서울시 종로구 자하문로 94"
    assert spans(record)[0] == ("region", "서울시")
    with pytest.raises(ValueError):
        render_row(label_row(), register="short_region")


def test_a_compound_sigungu_is_two_subregion_spans_with_the_space_outside_both() -> None:
    row = label_row(region="경기도", sigungu="수원시 장안구", dong="파장동", road="영동고속도로", number="31")
    record = render_row(row, register="no_dong")
    assert record["raw"] == "경기도 수원시 장안구 영동고속도로 31"
    assert spans(record)[1:3] == [("subregion", "수원시"), ("subregion", "장안구")]
    verify_cjk_record(record, TAGS)
    unspaced = render_row(row, register="unspaced")
    assert unspaced["raw"] == "경기도수원시장안구영동고속도로31"
    verify_cjk_record(unspaced, TAGS)


def test_sejong_has_no_sigungu_span_and_still_renders() -> None:
    row = label_row(region="세종특별자치시", sigungu="", dong="반곡동", road="한누리대로", number="1843-10")
    record = render_row(row, register="official")
    assert record["raw"] == "세종특별자치시 한누리대로 1843-10 (반곡동)"
    assert "subregion" not in record["span_tags"]
    assert eligible(row, 64) is None
    verify_cjk_record(record, TAGS)


def test_the_country_token_leads_and_stays_a_span() -> None:
    record = render_row(label_row(), register="no_dong", country=True)
    assert record["raw"].startswith("대한민국 ")
    assert spans(record)[0] == ("country", "대한민국")
    verify_cjk_record(record, TAGS)


def test_available_registers_follow_the_row() -> None:
    assert available_registers(label_row()) == tuple(REGISTER_WEIGHTS)
    without_dong = available_registers(label_row(dong="", lot=""))
    assert "official" not in without_dong and "jibun" not in without_dong
    assert "building" not in available_registers(label_row(building=""))
    assert "short_region" not in available_registers(label_row(region="가상도"))
    assert all(region in SHORT_REGIONS for region in ("서울특별시", "경기도", "제주특별자치도", "세종특별자치시"))


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"number": ""}, "missing_field"),
        ({"road": "가 나"}, "whitespace_shape"),
        ({"sigungu": "가 나 다"}, "whitespace_shape"),
        ({"road": "로" * 65}, "field_too_long"),
        ({}, None),
    ],
)
def test_eligible_names_the_reason_a_row_is_dropped(overrides: dict[str, Any], reason: str | None) -> None:
    assert eligible(label_row(**overrides), 64) == reason


def write_juso_zip(path: Path) -> None:
    """A two-address edition of the 주소DB in the portal's shape: CP949 members named without the UTF-8 flag."""
    road_codes = "\n".join(
        [
            "111104100001|자하문로|Jahamun-ro|01|서울특별시|Seoul|종로구|Jongno-gu|청운효자동|Cheongunhyoja-dong|1|1111010100|1",
            "511304100002|신림황둔로|Sillimhwangdun-ro|02|강원특별자치도|Gangwon|원주시|Wonju-si|신림면|Sillim-myeon|0|5113035000|1",
        ]
    )
    seoul_address = "11110000000001|111104100001|01|0|00094|00000|03047|0|20140101||1"
    seoul_lot = "11110000000001|1|1111010100|서울특별시|종로구|청운동||0|0052|0001|1"
    seoul_supplement = "11110000000001|1111051500|청운효자동|03047|001||청운빌딩||0"
    gangwon_address = "51130000000002|511304100002|02|0|00011|00000|26301|0|20140101||1"
    gangwon_lot = "51130000000002|1|5113035021|강원특별자치도|원주시|신림면|신림리|0|0668|0013|1"
    gangwon_supplement = "51130000000002|5113035000|신림면|26301|001||||0"
    members = {
        "개선_도로명코드_전체분.txt": road_codes,
        "주소_서울특별시.txt": seoul_address,
        "지번_서울특별시.txt": seoul_lot,
        "부가정보_서울특별시.txt": seoul_supplement,
        "주소_강원특별자치도.txt": gangwon_address,
        "지번_강원특별자치도.txt": gangwon_lot,
        "부가정보_강원특별자치도.txt": gangwon_supplement,
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in members.items():
            archive.writestr(CP949MemberInfo(name), text.encode("cp949"))


class CP949MemberInfo(zipfile.ZipInfo):
    """A member whose name is stored as CP949 bytes WITHOUT the UTF-8 flag, the way the portal writes them. `zipfile`
    itself always stores a non-ASCII name as UTF-8 with the flag, so a reader test needs this to meet the real shape."""

    def _encodeFilenameFlags(self) -> tuple[bytes, int]:  # noqa: N802 — zipfile's own hook name
        return self.filename.encode("cp949"), self.flag_bits


def test_iter_label_rows_joins_the_four_files_and_recodes_the_member_names(tmp_path: Path) -> None:
    archive = tmp_path / "202608ALLMTCHG00.zip"
    write_juso_zip(archive)
    rows = sorted(iter_label_rows(archive), key=lambda row: row.region)
    assert [row.region for row in rows] == ["강원특별자치도", "서울특별시"]
    gangwon, seoul = rows
    assert seoul == label_row()
    assert gangwon.eupmyeon == "신림면" and gangwon.ri == "신림리" and gangwon.lot == "668-13"
    assert gangwon.parenthetical == "신림리" and seoul.parenthetical == "청운동"
    assert render_row(gangwon, register="official")["raw"] == "강원특별자치도 원주시 신림면 신림황둔로 11 (신림리)"
    # The smoke-build cap is per region: one row from each of the two 시도.
    assert len(list(iter_label_rows(archive, max_rows_per_region=1))) == 2
