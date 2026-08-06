"""Fixtures for the Phase-3 JP shard recipe — rung 1 of the fixtures → smoke → full ladder.

Every expected string here is hand-readable Japanese: a reviewer can check 香川県高松市八島町二丁目3-16
by eye, which is the whole reason the Phase-0 de-risk was cheap. The span assertions are written as
(tag, sliced text) pairs rather than raw offsets so a failure says WHAT was mislabeled.
"""

from __future__ import annotations

import random

import pytest

from .build_jp_shard import (
    REGISTER_WEIGHTS,
    available_registers,
    coverage_stats,
    fold_halfwidth_kana,
    int_to_kanji,
    kanji_to_int,
    load_kenall_postcodes,
    normalize_name,
    normalize_number,
    render_row,
    select_exact,
    split_street,
    verify_record,
    water_fill,
)
from .labels import resolve_label_set

TAG_SET = frozenset(resolve_label_set("stage3-jp").tags)


def spans_of(record: dict) -> list[tuple[str, str]]:
    return [
        (tag, record["raw"][start:end])
        for start, end, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True)
    ]


# --- Normalization -------------------------------------------------------------------------------


def test_halfwidth_kana_fold_composes_dakuten_and_shortens_the_string() -> None:
    # The length-changing case the steal list names: ﾃ + ﾞ (2 code points) folds to デ (1).
    assert fold_halfwidth_kana("ﾃﾞ") == "デ"
    assert len(fold_halfwidth_kana("ﾃﾞ")) == 1
    # The shape it actually meets in the data (14,739 number values).
    assert fold_halfwidth_kana("813ﾛ号-2") == "813ロ号-2"


def test_hyphen_class_is_folded_in_numbers_and_left_alone_in_names() -> None:
    assert normalize_number("3ー16") == "3-16"
    assert normalize_number("3−16") == "3-16"
    assert normalize_number("3－16") == "3-16"
    # U+30FC inside a katakana name is a prolonged-sound mark, not a hyphen. Folding it corrupts
    # the name, so normalize_name must leave it.
    assert normalize_name("コーポ丘の上") == "コーポ丘の上"


def test_interior_ideographic_space_is_removed_from_a_name() -> None:
    # 135 street values carry a U+3000 between the machi and the aza. Left in, it lands INSIDE a
    # district span; the written form closes it up.
    assert normalize_name("西与賀町　字今津乙") == "西与賀町字今津乙"


def test_name_normalization_leaves_itaiji_alone() -> None:
    # Deliberate: the canonical collapse tables are CC BY-SA, so nothing derived from them ships.
    assert normalize_name("渡邊") == "渡邊"
    assert normalize_name("渡辺") == "渡辺"


# --- Numerals ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [("一", 1), ("九", 9), ("十", 10), ("十一", 11), ("二十", 20), ("二十三", 23), ("百", 100), ("百五", 105)],
)
def test_kanji_numerals_parse(text: str, expected: int) -> None:
    assert kanji_to_int(text) == expected


def test_both_registers_parse_to_the_same_number() -> None:
    assert kanji_to_int("2") == kanji_to_int("二") == 2
    assert kanji_to_int("２") == 2  # full-width ASCII register


def test_kanji_numeral_round_trip() -> None:
    for value in range(1, 121):
        assert kanji_to_int(int_to_kanji(value)) == value


def test_non_numeral_is_rejected_rather_than_guessed() -> None:
    assert kanji_to_int("崎枝") is None


# --- Street split --------------------------------------------------------------------------------


def test_chome_splits_off_the_district() -> None:
    assert split_street("八島町二丁目") == ("八島町", 2)


def test_plain_street_is_all_district() -> None:
    assert split_street("字崎枝") == ("字崎枝", None)


def test_bare_chome_leaves_an_empty_district() -> None:
    assert split_street("二丁目") == ("", 2)


def test_non_trailing_chome_is_left_whole() -> None:
    # 2,316 rows carry 丁目 somewhere other than the end. Re-rendering a form we have not read is
    # how a corpus grows labels nobody verified — so it stays one district span.
    assert split_street("一丁目北") == ("一丁目北", None)


# --- Rendering: the four registers, all from the same source row ---------------------------------

URBAN = {"prefecture": "香川県", "municipality": "高松市", "district": "八島町", "chome": 2, "number": "3-16"}
RURAL = {"prefecture": "沖縄県", "municipality": "石垣市", "district": "字崎枝", "chome": None, "number": "556-16"}


def render(base: dict, register: str, **kwargs) -> dict:
    return render_row(**base, register=register, postcode=None, spaced=False, country=False, **kwargs)


def test_native_register_matches_the_source_surface() -> None:
    record = render(URBAN, "native")
    assert record["raw"] == "香川県高松市八島町二丁目3-16"
    assert spans_of(record) == [
        ("prefecture", "香川県"),
        ("municipality", "高松市"),
        ("district", "八島町"),
        ("block", "二丁目"),
        ("house_number", "3-16"),
    ]


def test_arabic_chome_register_converts_only_the_chome() -> None:
    record = render(URBAN, "arabic_chome")
    assert record["raw"] == "香川県高松市八島町2丁目3-16"
    assert spans_of(record)[3] == ("block", "2丁目")


def test_compact_folded_register_is_one_whole_house_number_span() -> None:
    # D4: the compact form carries no per-part surface evidence, so it is ONE span. This register is
    # the only place the 3-part compact number exists — the source has zero of them.
    record = render(URBAN, "compact_folded")
    assert record["raw"] == "香川県高松市八島町2-3-16"
    assert spans_of(record) == [
        ("prefecture", "香川県"),
        ("municipality", "高松市"),
        ("district", "八島町"),
        ("house_number", "2-3-16"),
    ]


def test_designator_register_splits_on_the_kanji_that_is_the_evidence() -> None:
    record = render(URBAN, "designator")
    assert record["raw"] == "香川県高松市八島町二丁目3番16号"
    assert spans_of(record) == [
        ("prefecture", "香川県"),
        ("municipality", "高松市"),
        ("district", "八島町"),
        ("block", "二丁目"),
        ("sub_block", "3番"),
        ("building_number", "16号"),
    ]


def test_rural_row_has_no_block_in_any_register() -> None:
    native = render(RURAL, "native")
    assert native["raw"] == "沖縄県石垣市字崎枝556-16"
    assert [tag for tag, _ in spans_of(native)] == ["prefecture", "municipality", "district", "house_number"]
    designator = render(RURAL, "designator")
    assert designator["raw"] == "沖縄県石垣市字崎枝556番16号"


# --- Rendering: the modifiers --------------------------------------------------------------------


def test_the_postal_mark_stays_outside_the_postcode_span() -> None:
    record = render_row(**URBAN, register="native", postcode="7600017", spaced=False, country=False)
    assert record["raw"].startswith("〒760-0017 ")
    assert spans_of(record)[0] == ("postcode", "760-0017")


def test_country_renders_first_in_native_large_to_small_order() -> None:
    record = render_row(**URBAN, register="native", postcode=None, spaced=False, country=True)
    assert record["raw"].startswith("日本香川県")
    assert spans_of(record)[0] == ("country", "日本")


def test_spaced_variant_keeps_spans_off_the_spaces() -> None:
    record = render_row(**URBAN, register="native", postcode=None, spaced=True, country=False)
    assert record["raw"] == "香川県 高松市 八島町二丁目3-16"
    assert spans_of(record)[0] == ("prefecture", "香川県")
    assert spans_of(record)[1] == ("municipality", "高松市")


def test_variant_hyphen_survives_into_the_rendered_number() -> None:
    record = render_row(**URBAN, register="native", postcode=None, spaced=False, country=False, hyphen="ー")
    assert record["raw"].endswith("3ー16")
    assert spans_of(record)[-1] == ("house_number", "3ー16")


# --- Register availability -----------------------------------------------------------------------


def test_a_row_with_a_chome_and_a_clean_number_offers_every_register() -> None:
    assert available_registers(2, "3-16") == tuple(REGISTER_WEIGHTS)


def test_a_row_without_a_chome_cannot_offer_the_chome_registers() -> None:
    assert available_registers(None, "556-16") == ("native", "designator")


def test_a_number_we_cannot_reparse_stays_in_its_own_surface() -> None:
    # 103,299 rows look like 362B-2 / 761乙号-2. Re-rendering those as designators would invent
    # structure, so they render native-only.
    assert available_registers(None, "761乙号-2") == ("native",)
    assert available_registers(2, "362B-2") == ("native",)


# --- Verification + coverage ---------------------------------------------------------------------


def test_verify_accepts_every_register() -> None:
    for register in REGISTER_WEIGHTS:
        verify_record(render(URBAN, register), TAG_SET)


def test_stage3_jp_is_a_superset_so_the_universal_tags_are_still_legal() -> None:
    # Worth pinning: stage3-jp = STAGE3's 16 + the JP seven. `region`/`locality`/`street` do not
    # vanish, they just get no support from this shard — a zero the build report has to name rather
    # than a collapse the loader would hide.
    assert {"region", "locality", "street"} <= TAG_SET
    assert {"prefecture", "municipality", "district", "block"} <= TAG_SET


def test_verify_rejects_a_tag_outside_the_active_label_set() -> None:
    record = render(URBAN, "native")
    record["span_tags"] = list(record["span_tags"])
    # A STAGE4 tag: defined in labels.py, absent from stage3-jp, and therefore silently collapsed
    # to O at load if the builder ever emitted one (#1349's failure mode).
    record["span_tags"][0] = "unit_designator"
    with pytest.raises(RuntimeError, match="outside stage3-jp"):
        verify_record(record, TAG_SET)


def test_verify_rejects_a_row_that_would_be_truncated_at_s96() -> None:
    record = render_row(
        prefecture="香川県",
        municipality="高松市",
        district="八" * 90,
        chome=None,
        number="3-16",
        postcode=None,
        register="native",
        spaced=False,
        country=False,
    )
    with pytest.raises(RuntimeError, match="exceeds S=96"):
        verify_record(record, TAG_SET)


def test_verify_rejects_whitespace_inside_a_span() -> None:
    record = render_row(
        prefecture="佐賀県",
        municipality="佐賀市",
        district="西与賀町　字今津乙",  # un-normalized on purpose
        chome=None,
        number="99-2",
        postcode=None,
        register="native",
        spaced=False,
        country=False,
    )
    with pytest.raises(RuntimeError, match="whitespace inside span"):
        verify_record(record, TAG_SET)


def test_verify_rejects_an_all_o_row() -> None:
    record = render(URBAN, "native")
    record["span_starts"], record["span_ends"], record["span_tags"] = [], [], []
    with pytest.raises(RuntimeError, match="all-O"):
        verify_record(record, TAG_SET)


def test_every_significant_character_carries_a_label() -> None:
    # The JSON-hides-gaps read: counted on the label ARRAY the loader builds, not on the triple.
    records = [render(URBAN, register) for register in REGISTER_WEIGHTS]
    records.append(render_row(**URBAN, register="native", postcode="7600017", spaced=True, country=True))
    stats = coverage_stats(records)
    assert stats["bio_char_coverage_significant"] == 1.0
    # block fires in every register but compact_folded, where the chōme is inside the number span.
    assert stats["per_tag_rows"]["block"] == len(records) - 1
    assert stats["per_label_chars"]["B-prefecture"] == len(records)


# --- The KEN_ALL 〒 join --------------------------------------------------------------------------

KENALL_FIXTURE = "\n".join(
    [
        '"0600000","北海道","札幌市　中央区","以下に掲載がない場合","HOKKAIDO","SAPPORO SHI CHUO KU","IKANI"',
        '"0640941","北海道","札幌市　中央区","旭ケ丘","HOKKAIDO","SAPPORO SHI CHUO KU","ASAHIGAOKA"',
        '"0600041","北海道","札幌市　中央区","大通東（１～１３丁目）","HOKKAIDO","SAPPORO SHI CHUO KU","ODORI"',
        '"9070003","沖縄県","石垣市","崎枝","OKINAWA KEN","ISHIGAKI SHI","SAKIEDA"',
    ]
)


def kenall(tmp_path) -> object:
    path = tmp_path / "KEN_ALL_ROME.CSV"
    path.write_bytes(KENALL_FIXTURE.encode("cp932"))
    return load_kenall_postcodes(path)


def test_town_level_join_beats_the_municipality_catch_all(tmp_path) -> None:
    index = kenall(tmp_path)
    assert index.lookup("北海道", "札幌市中央区", "旭ケ丘") == ("0640941", "town")
    # Without a town match the fallback is the NNN-0000 catch-all — the ONLY thing the probe ever got.
    assert index.lookup("北海道", "札幌市中央区", "存在しない町") == ("0600000", "municipality")


def test_the_aza_prefix_is_stripped_on_the_retry(tmp_path) -> None:
    # Overture writes 字崎枝, KEN_ALL writes 崎枝. This retry is worth 17.8% → 89.6% of rows.
    index = kenall(tmp_path)
    assert index.lookup("沖縄県", "石垣市", "字崎枝") == ("9070003", "town_aza_stripped")
    assert index.lookup("沖縄県", "石垣市", "崎枝") == ("9070003", "town")


def test_parenthetical_annotations_are_stripped_from_the_town_name(tmp_path) -> None:
    index = kenall(tmp_path)
    assert index.lookup("北海道", "札幌市中央区", "大通東") == ("0600041", "town")


def test_the_catch_all_literal_never_becomes_a_town(tmp_path) -> None:
    index = kenall(tmp_path)
    assert index.lookup("北海道", "札幌市中央区", "以下に掲載がない場合") == ("0600000", "municipality")


# --- Sampling ------------------------------------------------------------------------------------


def test_exact_selection_yields_exactly_the_quota() -> None:
    rng = random.Random(7)
    assert sum(select_exact(1000, 137, rng)) == 137
    assert sum(select_exact(50, 200, rng)) == 50


def test_water_fill_caps_the_dominant_bucket() -> None:
    # Tokyo cannot drown Tottori: the cap is the level, not the share.
    counts = {"tokyo": 1_992_163, "tottori": 40_000, "kagawa": 120_000}
    cap = water_fill(counts, 300_000)
    assert cap == 140_000  # 140,000 + 40,000 + 120,000 = 300,000 exactly
    assert sum(min(cap, n) for n in counts.values()) <= 300_000
    assert sum(min(cap + 1, n) for n in counts.values()) > 300_000  # and it is the LARGEST such cap
