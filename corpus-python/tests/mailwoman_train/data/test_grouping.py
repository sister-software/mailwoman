"""The grouping-character augmentation keeps every span on its component's text (#2845)."""

from __future__ import annotations

import random
from typing import Any

from mailwoman_train.data.augment import augment_row
from mailwoman_train.data.augment.grouping import group_row, wrap_row, wrap_span
from mailwoman_train.tokenizer import whitespace_spans
from tests.mailwoman_train.data.test_postcode_move import make_row


def _span_texts(row: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        (tag, row["raw"][start:end])
        for start, end, tag in zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)
    ]


def _boston() -> dict[str, Any]:
    return make_row(
        "123 Main St, Boston, MA 02111, USA",
        [
            ("house_number", "123"),
            ("street", "Main St"),
            ("locality", "Boston"),
            ("region", "MA"),
            ("postcode", "02111"),
            ("country", "USA"),
        ],
        "US",
    )


def _cafe() -> dict[str, Any]:
    return make_row(
        "Café Le Dôme, 108 Boulevard du Montparnasse, 75014 Paris",
        [
            ("venue", "Café Le Dôme"),
            ("house_number", "108"),
            ("street", "Boulevard du Montparnasse"),
            ("postcode", "75014"),
            ("locality", "Paris"),
        ],
        "FR",
    )


def _assert_consistent(before: dict[str, Any], after: dict[str, Any]) -> None:
    assert _span_texts(after) == _span_texts(before)
    assert len(after["tokens"]) == len(after["labels"])
    whitespace_spans(after["raw"], after["tokens"])


def test_wrapping_the_row_shifts_every_span_and_keeps_its_text() -> None:
    row = _boston()
    wrapped = wrap_row(row, ('"', '"'))

    assert wrapped is not None
    assert wrapped["raw"] == '"123 Main St, Boston, MA 02111, USA"'
    assert wrapped["tokens"][0] == '"123'
    assert wrapped["labels"] == row["labels"]
    _assert_consistent(row, wrapped)


def _pchyolka() -> dict[str, Any]:
    """The `osm-ru` row of #2878 with its corpus tokens. The tokens leave out the comma and the guillemets."""
    return make_row(
        "114, СНТ «Пчёлка»",
        [("house_number", "114"), ("dependent_locality", "СНТ «Пчёлка»")],
        "RU",
        tokens=["114", "СНТ", "Пчёлка"],
    )


def test_a_row_whose_text_runs_past_its_last_token_is_not_wrapped() -> None:
    assert wrap_row(_pchyolka(), ("{", "}")) is None
    leading = make_row(
        "«Пчёлка» 114",
        [("dependent_locality", "«Пчёлка»"), ("house_number", "114")],
        "RU",
        tokens=["Пчёлка", "114"],
    )
    assert wrap_row(leading, ("{", "}")) is None
    assert wrap_row(_boston(), ("{", "}")) is not None


def test_grouping_skips_the_row_rather_than_failing_the_stream() -> None:
    for seed in range(40):
        grouped = group_row(_pchyolka(), random.Random(seed))
        if grouped is not None:
            _assert_consistent(_pchyolka(), grouped)


def test_wrapping_a_venue_leaves_the_guillemets_outside_its_span() -> None:
    row = _cafe()
    wrapped = wrap_span(row, frozenset({"venue"}), ("«", "»"))

    assert wrapped is not None
    assert wrapped["raw"].startswith("«Café Le Dôme», 108")
    _assert_consistent(row, wrapped)


def test_bracketing_a_trailing_country() -> None:
    row = _boston()
    wrapped = wrap_span(row, frozenset({"country"}), ("(", ")"))

    assert wrapped is not None
    assert wrapped["raw"].endswith("MA 02111, (USA)")
    _assert_consistent(row, wrapped)


def test_a_cjk_row_is_wrapped_in_a_full_width_pair() -> None:
    row = make_row(
        "東京都港区六本木6-10-1",
        [("region", "東京都"), ("locality", "港区"), ("dependent_locality", "六本木"), ("house_number", "6-10-1")],
        "JP",
        tokens=["東京都港区六本木6-10-1"],
    )

    for seed in range(10):
        grouped = group_row(row, random.Random(seed))
        assert grouped is not None
        assert grouped["raw"][0] in "「（『【"
        _assert_consistent(row, grouped)


def test_every_variant_keeps_the_spans_across_seeds() -> None:
    for row in (_boston(), _cafe()):
        for seed in range(40):
            grouped = group_row(row, random.Random(seed))
            assert grouped is not None
            assert _span_texts(grouped) == _span_texts(row)
            assert len(grouped["tokens"]) == len(grouped["labels"])
            whitespace_spans(grouped["raw"], grouped["tokens"])


def test_a_note_appends_unlabeled_tokens() -> None:
    row = _boston()
    for seed in range(40):
        grouped = group_row(row, random.Random(seed))
        assert grouped is not None
        if grouped["raw"].endswith(")") and not grouped["raw"].endswith("(USA)"):
            assert grouped["raw"].startswith("123")
            appended = grouped["labels"][len(row["labels"]) :]
            assert appended and set(appended) == {"O"}
            return
    raise AssertionError("no seed in 0..39 chose the note variant")


def test_zero_leaves_the_stream_bit_identical() -> None:
    for seed in range(20):
        before, after = random.Random(seed), random.Random(seed)
        a = list(augment_row(_boston(), before, 0.3, 0.3, case_prob=0.2, postcode_move_prob=0.2))
        b = list(augment_row(_boston(), after, 0.3, 0.3, case_prob=0.2, postcode_move_prob=0.2, grouping_prob=0.0))
        assert a == b
        assert before.getstate() == after.getstate()


def test_draws_last_so_earlier_copies_are_unchanged() -> None:
    without = list(augment_row(_boston(), random.Random(3), 1.0, 1.0, case_prob=1.0))
    with_grouping = list(augment_row(_boston(), random.Random(3), 1.0, 1.0, case_prob=1.0, grouping_prob=1.0))

    assert with_grouping[: len(without)] == without
    assert len(with_grouping) == len(without) + 1
