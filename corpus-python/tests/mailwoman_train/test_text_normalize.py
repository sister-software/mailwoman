"""The shared CJK text helpers and row machinery answer from their own homes.

These names lived in `build_jp_slice.py`, which made a government-register reader import a corpus
builder to get `normalize_name`, and made four sibling builders import it for the row schema.
"""

from __future__ import annotations

import pytest

from mailwoman_train.corpora.builder import (
    MAX_RENDERED_CHARS,
    SCHEMA,
    RowRenderer,
    muni_bucket,
    verify_record,
)
from mailwoman_train.text.kana import fold_halfwidth_kana, int_to_kanji, kanji_to_int
from mailwoman_train.text.normalize import ascii_digits, normalize_text


def test_fold_halfwidth_kana_folds_halfwidth_to_fullwidth() -> None:
    assert fold_halfwidth_kana("ｶﾀｶﾅ") == "カタカナ"


def test_fold_halfwidth_kana_leaves_the_prolonged_sound_mark_alone() -> None:
    # U+30FC is a real katakana character inside a place name; folding it to "-" corrupts the name.
    assert fold_halfwidth_kana("コーヒー") == "コーヒー"


def test_kanji_to_int_reads_a_chome_numeral() -> None:
    assert kanji_to_int("二") == 2


def test_kanji_to_int_answers_none_for_a_non_numeral() -> None:
    assert kanji_to_int("字") is None


def test_int_to_kanji_inverts_kanji_to_int() -> None:
    for value in (1, 2, 9, 10, 11, 20, 21):
        assert kanji_to_int(int_to_kanji(value)) == value


def test_normalize_text_strips_an_ideographic_space() -> None:
    # 135 street values carry U+3000 as a rendering artifact of the source; the written form closes
    # it up. `str.split()` treats U+3000 as whitespace, which is why no explicit replace is needed.
    assert normalize_text("西与賀町　字今津乙") == "西与賀町字今津乙"


def test_ascii_digits_folds_fullwidth_numerals() -> None:
    assert ascii_digits("１２３") == "123"


def test_the_row_schema_answers_from_corpora() -> None:
    assert SCHEMA is not None
    assert "raw" in SCHEMA.names


def test_row_renderer_records_a_span_per_labeled_field() -> None:
    renderer = RowRenderer()
    renderer.put("region", "東京都")
    renderer.glue(" ")
    renderer.put("locality", "千代田区")

    assert renderer.raw == "東京都 千代田区"
    assert renderer.tags == ["region", "locality"]
    assert renderer.starts == [0, 4]
    assert renderer.ends == [3, 8]


def test_muni_bucket_is_stable_across_an_ideographic_space() -> None:
    assert muni_bucket("千代田区") == muni_bucket("千代田　区")


def _record(tag: str) -> dict[str, object]:
    return {"raw": "東京都", "span_starts": [0], "span_ends": [3], "span_tags": [tag]}


def test_verify_record_names_the_label_set_it_was_given() -> None:
    """A caller's own label set appears in the message, not the verifier's module constant.

    `build_tw_slice` imported this function from `build_jp_slice`, so a Taiwanese row with an
    out-of-set tag reported `stage3-jp` while the tag set checked was `stage3-cjk`.
    """
    with pytest.raises(RuntimeError, match="stage3-cjk"):
        verify_record(_record("B-nonsense"), frozenset({"B-region"}), label_set_name="stage3-cjk")

    with pytest.raises(RuntimeError, match="stage3-jp"):
        verify_record(_record("B-nonsense"), frozenset({"B-region"}), label_set_name="stage3-jp")


def test_verify_record_forbids_whitespace_by_default_and_admits_it_on_request() -> None:
    spaced: dict[str, object] = {
        "raw": "東京 都",
        "span_starts": [0],
        "span_ends": [3],
        "span_tags": ["B-region"],
    }
    tags = frozenset({"B-region"})

    with pytest.raises(RuntimeError, match="whitespace inside span"):
        verify_record(spaced, tags, label_set_name="stage3-jp")

    verify_record(spaced, tags, label_set_name="stage3-cjk", forbid_whitespace=False)


def test_verify_record_refuses_a_row_that_would_truncate() -> None:
    long_raw = "東" * (MAX_RENDERED_CHARS + 1)
    record: dict[str, object] = {
        "raw": long_raw,
        "span_starts": [0],
        "span_ends": [len(long_raw)],
        "span_tags": ["B-region"],
    }

    with pytest.raises(RuntimeError, match="would truncate"):
        verify_record(record, frozenset({"B-region"}), label_set_name="stage3-jp")
