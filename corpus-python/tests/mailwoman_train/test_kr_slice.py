"""The Korean corpus builder: registers, span discipline, the compound 시군구, and a tiny end-to-end build."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from mailwoman_train.build_jp_slice import verify_record
from mailwoman_train.build_kr_slice import (
    REGISTER_WEIGHTS,
    SHORT_REGIONS,
    available_registers,
    build,
    iter_source_rows,
    render_row,
)
from mailwoman_train.labels import resolve_label_set

TAGS = frozenset(resolve_label_set("stage3-cjk").tags)


def seoul(register: str, **overrides: Any) -> dict[str, Any]:
    """The Jongno-gu row of the census, rendered in `register`."""
    return render_row(
        region="서울특별시",
        city="종로구",
        district="청운동",
        street="자하문로",
        number="94",
        postcode="03047",
        register=register,
        **overrides,
    )


def spans(record: dict[str, Any]) -> list[tuple[str, str]]:
    raw = record["raw"]
    return [
        (tag, raw[s:e])
        for s, e, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True)
    ]


def test_official_register_is_the_source_form_with_the_dong_in_parentheses() -> None:
    record = seoul("official")
    assert record["raw"] == "서울특별시 종로구 자하문로 94 (청운동)"
    assert spans(record) == [
        ("region", "서울특별시"),
        ("subregion", "종로구"),
        ("street", "자하문로"),
        ("house_number", "94"),
        ("dependent_locality", "청운동"),
    ]
    verify_record(record, TAGS)


@pytest.mark.parametrize(
    ("register", "expected"),
    [
        ("no_dong", "서울특별시 종로구 자하문로 94"),
        ("postcode_first", "03047 서울특별시 종로구 자하문로 94"),
        ("unspaced", "서울특별시종로구자하문로94"),
    ],
)
def test_the_typed_registers(register: str, expected: str) -> None:
    record = seoul(register)
    assert record["raw"] == expected
    assert "dependent_locality" not in record["span_tags"]
    verify_record(record, TAGS)


def test_short_region_replaces_the_region_span_only() -> None:
    record = seoul("short_region", short_region="서울시")
    assert record["raw"] == "서울시 종로구 자하문로 94"
    assert spans(record)[0] == ("region", "서울시")
    with pytest.raises(ValueError):
        seoul("short_region")


def test_a_compound_sigungu_is_two_subregion_spans_with_the_space_outside_both() -> None:
    record = render_row(
        region="경기도",
        city="수원시 장안구",
        district="파장동",
        street="영동고속도로",
        number="31",
        postcode="16201",
        register="no_dong",
    )
    assert record["raw"] == "경기도 수원시 장안구 영동고속도로 31"
    assert spans(record)[1:3] == [("subregion", "수원시"), ("subregion", "장안구")]
    verify_record(record, TAGS)
    unspaced = render_row(
        region="경기도",
        city="수원시 장안구",
        district="파장동",
        street="영동고속도로",
        number="31",
        postcode="16201",
        register="unspaced",
    )
    assert unspaced["raw"] == "경기도수원시장안구영동고속도로31"
    verify_record(unspaced, TAGS)


def test_sejong_has_no_sigungu_span() -> None:
    record = render_row(
        region="세종특별자치시",
        city="",
        district="반곡동",
        street="한누리대로",
        number="1843-10",
        postcode="30145",
        register="official",
    )
    assert record["raw"] == "세종특별자치시 한누리대로 1843-10 (반곡동)"
    assert "subregion" not in record["span_tags"]
    verify_record(record, TAGS)


def test_the_country_token_leads_and_stays_a_span() -> None:
    record = seoul("no_dong", country=True)
    assert record["raw"].startswith("대한민국 ")
    assert spans(record)[0] == ("country", "대한민국")
    verify_record(record, TAGS)


def test_available_registers_follow_the_row() -> None:
    assert available_registers("서울특별시", "청운동") == tuple(REGISTER_WEIGHTS)
    assert "official" not in available_registers("서울특별시", "")
    assert "short_region" not in available_registers("가상도", "청운동")
    assert all(region in SHORT_REGIONS for region in ("서울특별시", "경기도", "제주특별자치도", "세종특별자치시"))


def write_province(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "LON",
                "LAT",
                "NUMBER",
                "STREET",
                "UNIT",
                "CITY",
                "DISTRICT",
                "REGION",
                "POSTCODE",
                "ID",
                "HASH",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({"LON": "126.97", "LAT": "37.58", "UNIT": "", "ID": "x", "HASH": "y", **row})


def test_iter_source_rows_drops_the_shapes_the_renderer_cannot_carry(tmp_path: Path) -> None:
    write_province(
        tmp_path / "11" / "provincewide.csv",
        [
            {
                "NUMBER": "94",
                "STREET": "자하문로",
                "CITY": "종로구",
                "DISTRICT": "청운동",
                "REGION": "서울특별시",
                "POSTCODE": "03047",
            },
            {
                "NUMBER": "",
                "STREET": "자하문로",
                "CITY": "종로구",
                "DISTRICT": "청운동",
                "REGION": "서울특별시",
                "POSTCODE": "03047",
            },
            {
                "NUMBER": "1",
                "STREET": "가 나",
                "CITY": "종로구",
                "DISTRICT": "청운동",
                "REGION": "서울특별시",
                "POSTCODE": "03047",
            },
        ],
    )
    (tmp_path / "seoul").mkdir()
    counter: Counter[str] = Counter()
    rows = list(iter_source_rows(tmp_path, dropped=counter))
    assert [row[3] for row in rows] == ["자하문로"]
    assert counter == {"missing_field": 1, "whitespace_shape": 1}


def test_a_tiny_build_writes_parts_board_centroids_and_vocab(tmp_path: Path) -> None:
    source = tmp_path / "kr"
    regions = [("서울특별시", "11"), ("경기도", "41"), ("제주특별자치도", "50")]
    for region, code in regions:
        rows = []
        for city in ("A구", "B구", "C시 D구", "E군", "F시", "G구", "H시", "I군", "J구", "K시", "L시 M구", "N구"):
            for n in range(6):
                rows.append(
                    {
                        "NUMBER": str(n + 1),
                        "STREET": f"{city[0]}로",
                        "CITY": city,
                        "DISTRICT": "청운동",
                        "REGION": region,
                        "POSTCODE": "03047",
                    }
                )
        write_province(source / code / "provincewide.csv", rows)
    out = tmp_path / "out"
    report = build(
        argparse.Namespace(
            source_dir=str(source),
            out_dir=str(out),
            train_rows=120,
            val_rows=20,
            board_rows=20,
            board_bucket_min=60,
            rows_per_part=50,
            stats_sample_per_part=50,
            country_fraction=0.1,
            max_field_chars=64,
            max_rows_per_file=None,
            seed=7,
            force=False,
        )
    )
    assert report["splits"]["train"]["rows"] == 120
    assert report["splits"]["train"]["parts"] == 3
    assert report["board_rows"] > 0
    assert report["board_sigungu"] > 0
    assert report["regions_train"] == 3 or report["regions_train"] == 17
    board = [json.loads(line) for line in (out / "kr-board.jsonl").read_text(encoding="utf-8").splitlines()]
    assert {row["register"] for row in board} <= set(REGISTER_WEIGHTS)
    centroids = json.loads((out / "kr-sigungu-centroids.json").read_text(encoding="utf-8"))
    assert all(len(value) == 2 for value in centroids.values())
    vocab = json.loads((out / "char-vocab-kr.json").read_text(encoding="utf-8"))
    assert "<pad>" in vocab and "로" in vocab
