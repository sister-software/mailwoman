"""The postcode move (#2750): where the postcode and its separator land, what it skips, and its draw guard at 0."""

from __future__ import annotations

import random
import re
from collections import Counter
from typing import Any

import pytest

from mailwoman_train.data.augment import SkipReason, augment_row, move_postcode, postcode_layouts
from mailwoman_train.data.emit import POSTCODE_MOVE_EXCLUDED_SOURCES, EmitPolicy, emit_row
from mailwoman_train.data.loader.stream import TrainOnlyPolicy, neutralized_for
from mailwoman_train.tokenizer import whitespace_spans

# The corpus tokenizer's word runs (`packages/corpus/lib/utils/tokenize.ts`), which never include separator commas.
_WORD = re.compile(r"[\w'\-]+")


def make_row(
    raw: str,
    spans: list[tuple[str, str]],
    country: str,
    *,
    tokens: list[str] | None = None,
    source: str = "openaddresses",
) -> dict[str, Any]:
    """A row with spans located left to right and BIO labels assigned by span containment, as `alignRow` does."""
    starts: list[int] = []
    ends: list[int] = []
    cursor = 0
    for _, text in spans:
        start = raw.index(text, cursor)
        starts.append(start)
        ends.append(start + len(text))
        cursor = start + len(text)
    tags = [tag for tag, _ in spans]
    if tokens is None:
        tokens = [match.group() for match in _WORD.finditer(raw)]
    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels_from_spans(raw, tokens, starts, ends, tags),
        "span_starts": starts,
        "span_ends": ends,
        "span_tags": tags,
        "country": country,
        "source": source,
    }


def labels_from_spans(raw: str, tokens: list[str], starts: list[int], ends: list[int], tags: list[str]) -> list[str]:
    seen: set[int] = set()
    labels: list[str] = []
    for token_start, token_end in whitespace_spans(raw, tokens):
        label = "O"
        for index, (start, end) in enumerate(zip(starts, ends, strict=True)):
            # A legacy token keeps its trailing comma, so containment is read on the token's word.
            word_end = token_start + len(raw[token_start:token_end].rstrip(",;"))
            if start <= token_start and word_end <= end:
                label = f"{'I' if index in seen else 'B'}-{tags[index]}"
                seen.add(index)
                break
        labels.append(label)
    return labels


def span_texts(row: dict[str, Any]) -> list[tuple[str, str]]:
    triple = zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)
    return sorted((tag, row["raw"][start:end]) for start, end, tag in triple)


def assert_aligned(original: dict[str, Any], moved: dict[str, Any]) -> None:
    """Every span still covers its component's text, the triple is sorted, and the labels agree with the spans."""
    assert span_texts(moved) == span_texts(original)
    assert moved["span_starts"] == sorted(moved["span_starts"])
    assert len(moved["tokens"]) == len(moved["labels"])
    assert moved["labels"] == labels_from_spans(
        moved["raw"], moved["tokens"], moved["span_starts"], moved["span_ends"], moved["span_tags"]
    )
    assert Counter(moved["labels"]) == Counter(original["labels"])


class TestSeparatorPlacement:
    def test_madrid_comma_stays_at_the_boundary(self) -> None:
        # Spain prints `28013 Madrid`; the layout table is overridden so the comma form is the native one here.
        row = make_row(
            "Calle Mayor 12, Madrid, 28013",
            [("street", "Calle Mayor"), ("house_number", "12"), ("locality", "Madrid"), ("postcode", "28013")],
            "ES",
        )
        moved, reason = move_postcode(row, {"ES": "after"})
        assert reason is None and moved is not None
        assert moved["raw"] == "Calle Mayor 12, 28013, Madrid"
        assert_aligned(row, moved)

    def test_madrid_legacy_token_drops_its_comma_rather_than_carrying_it(self) -> None:
        row = make_row(
            "Calle Mayor 12, Madrid, 28013",
            [("street", "Calle Mayor"), ("house_number", "12"), ("locality", "Madrid"), ("postcode", "28013")],
            "ES",
            tokens=["Calle", "Mayor", "12,", "Madrid,", "28013"],
        )
        moved, _ = move_postcode(row, {"ES": "after"})
        assert moved is not None
        assert moved["raw"] == "Calle Mayor 12, 28013, Madrid"
        assert moved["tokens"] == ["Calle", "Mayor", "12,", "28013", "Madrid"]
        assert moved["labels"] == ["B-street", "I-street", "B-house_number", "B-postcode", "B-locality"]

    def test_madrid_native_space_form(self) -> None:
        row = make_row(
            "Calle Mayor 12, 28013 Madrid",
            [("street", "Calle Mayor"), ("house_number", "12"), ("postcode", "28013"), ("locality", "Madrid")],
            "ES",
        )
        moved, reason = move_postcode(row)
        assert reason is None and moved is not None
        assert moved["raw"] == "Calle Mayor 12, Madrid 28013"
        assert_aligned(row, moved)

    def test_sao_paulo_block_keeps_its_inner_separator(self) -> None:
        row = make_row(
            "Av. Paulista 1000, São Paulo - SP, 01310-100",
            [
                ("street", "Av. Paulista"),
                ("house_number", "1000"),
                ("locality", "São Paulo"),
                ("region", "SP"),
                ("postcode", "01310-100"),
            ],
            "BR",
        )
        moved, reason = move_postcode(row)
        assert reason is None and moved is not None
        assert moved["raw"] == "Av. Paulista 1000, 01310-100, São Paulo - SP"
        assert_aligned(row, moved)
        assert moved["tokens"][-4:] == ["São", "Paulo", "-", "SP"]

    def test_brooklyn_postcode_moves_ahead_of_locality_and_region(self) -> None:
        row = make_row(
            "123 Main St, Brooklyn, NY 11226",
            [
                ("house_number", "123"),
                ("street", "Main St"),
                ("locality", "Brooklyn"),
                ("region", "NY"),
                ("postcode", "11226"),
            ],
            "US",
        )
        moved, reason = move_postcode(row)
        assert reason is None and moved is not None
        assert moved["raw"] == "123 Main St, 11226 Brooklyn, NY"
        assert_aligned(row, moved)

    def test_a_trailing_country_stays_in_place(self) -> None:
        row = make_row(
            "123 Main St, Brooklyn, NY 11226, USA",
            [
                ("house_number", "123"),
                ("street", "Main St"),
                ("locality", "Brooklyn"),
                ("region", "NY"),
                ("postcode", "11226"),
                ("country", "USA"),
            ],
            "US",
        )
        moved, _ = move_postcode(row)
        assert moved is not None
        assert moved["raw"] == "123 Main St, 11226 Brooklyn, NY, USA"
        assert_aligned(row, moved)


class TestSkipReasons:
    def _rome(self, **overrides: Any) -> dict[str, Any]:
        row = make_row(
            "Via del Corso 12, 00186 Roma",
            [("street", "Via del Corso"), ("house_number", "12"), ("postcode", "00186"), ("locality", "Roma")],
            "IT",
        )
        return {**row, **overrides}

    def test_moves_the_reference_row(self) -> None:
        moved, reason = move_postcode(self._rome())
        assert reason is None and moved is not None
        assert moved["raw"] == "Via del Corso 12, Roma 00186"

    def test_no_spans(self) -> None:
        row = {k: v for k, v in self._rome().items() if not k.startswith("span_")}
        assert move_postcode(row) == (None, SkipReason.NO_SPANS)

    def test_no_street(self) -> None:
        row = make_row("00186 Roma", [("postcode", "00186"), ("locality", "Roma")], "IT")
        assert move_postcode(row) == (None, SkipReason.NO_STREET)

    def test_no_postcode(self) -> None:
        row = make_row(
            "Via del Corso 12, Roma", [("street", "Via del Corso"), ("house_number", "12"), ("locality", "Roma")], "IT"
        )
        assert move_postcode(row) == (None, SkipReason.NO_POSTCODE)

    def test_no_layout(self) -> None:
        # The UAE's layout prints no postcode.
        assert "AE" not in postcode_layouts()
        assert move_postcode(self._rome(country="AE")) == (None, SkipReason.NO_LAYOUT)

    @pytest.mark.parametrize("country", ["JP", "SG", "GI", "KY"])
    def test_no_locality_field(self, country: str) -> None:
        assert move_postcode(self._rome(country=country)) == (None, SkipReason.NO_LOCALITY_FIELD)

    def test_layout_between(self) -> None:
        assert postcode_layouts()["IN"] == "between"
        assert move_postcode(self._rome(country="IN")) == (None, SkipReason.LAYOUT_BETWEEN)

    def test_not_block_when_a_span_splits_the_tail(self) -> None:
        row = make_row(
            "Via del Corso 12, 00186 Centro Roma",
            [
                ("street", "Via del Corso"),
                ("house_number", "12"),
                ("postcode", "00186"),
                ("dependent_locality", "Centro"),
                ("locality", "Roma"),
            ],
            "IT",
        )
        assert move_postcode(row) == (None, SkipReason.NOT_BLOCK)

    def test_not_block_when_an_unlabeled_word_separates_them(self) -> None:
        row = make_row(
            "Via del Corso 12, 00186 presso Roma",
            [("street", "Via del Corso"), ("house_number", "12"), ("postcode", "00186"), ("locality", "Roma")],
            "IT",
        )
        assert move_postcode(row) == (None, SkipReason.NOT_BLOCK)

    def test_not_block_when_the_postcode_is_glued(self) -> None:
        row = make_row(
            "123 Main St, Brooklyn, NY11226",
            [
                ("house_number", "123"),
                ("street", "Main St"),
                ("locality", "Brooklyn"),
                ("region", "NY"),
                ("postcode", "11226"),
            ],
            "US",
            tokens=["123", "Main", "St", "Brooklyn", "NY11226"],
        )
        assert move_postcode(row) == (None, SkipReason.NOT_BLOCK)

    def test_non_native(self) -> None:
        row = make_row(
            "Via del Corso 12, Roma 00186",
            [("street", "Via del Corso"), ("house_number", "12"), ("locality", "Roma"), ("postcode", "00186")],
            "IT",
        )
        assert move_postcode(row) == (None, SkipReason.NON_NATIVE)

    def test_word_across_boundary(self) -> None:
        # The legacy token `NY,11226` holds the region and the postcode, one on each side of the boundary.
        row = make_row(
            "123 Main St, Brooklyn, NY,11226",
            [
                ("house_number", "123"),
                ("street", "Main St"),
                ("locality", "Brooklyn"),
                ("region", "NY"),
                ("postcode", "11226"),
            ],
            "US",
            tokens=["123", "Main", "St,", "Brooklyn,", "NY,11226"],
        )
        assert move_postcode(row) == (None, SkipReason.WORD_ACROSS_BOUNDARY)


class TestSpanShapesThatCrashedEncoding:
    """Shapes from the v0.8.0 sweep whose moved rows failed `char_label_array_from_spans` (run p005)."""

    @staticmethod
    def _notary_row() -> dict[str, Any]:
        # state-ny-notaries stores the locality span from the space after the street: street [19, 26), locality
        # [26, 35). The move used to carry the street's end with the block, so the street nested the postcode.
        raw = "THERESA TEBBETT 99 MAIN ST HEPSTEAD NY 11550"
        starts, ends = [0, 16, 19, 26, 36, 39], [15, 18, 26, 35, 38, 44]
        tags = ["venue", "house_number", "street", "locality", "region", "postcode"]
        tokens = raw.split()
        return {
            "raw": raw,
            "tokens": tokens,
            "labels": labels_from_spans(raw, tokens, starts, ends, tags),
            "span_starts": starts,
            "span_ends": ends,
            "span_tags": tags,
            "country": "US",
            "source": "state-ny-notaries",
        }

    def test_locality_span_holding_the_leading_space_is_skipped(self) -> None:
        assert move_postcode(self._notary_row()) == (None, SkipReason.SPAN_EDGE_WHITESPACE)

    def test_overlapping_input_spans_are_skipped(self) -> None:
        # The observed crash: postcode@[34, 39) inside a span at [23, 40).
        row = self._notary_row()
        row["span_starts"] = [0, 16, 19, 23, 36, 34]
        row["span_ends"] = [15, 18, 22, 40, 38, 39]
        assert move_postcode(row) == (None, SkipReason.SPANS_OVERLAP)

    def test_a_span_ending_at_the_block_start_stays_put(self) -> None:
        # A comma with no space between the street and a trimmed block: the street keeps its end.
        raw = "1 Main St,Brooklyn NY 11214"
        starts, ends, tags = (
            [0, 2, 10, 19, 22],
            [1, 9, 18, 21, 27],
            ["house_number", "street", "locality", "region", "postcode"],
        )
        tokens = ["1", "Main", "St", "Brooklyn", "NY", "11214"]
        row = {
            "raw": raw,
            "tokens": tokens,
            "labels": labels_from_spans(raw, tokens, starts, ends, tags),
            "span_starts": starts,
            "span_ends": ends,
            "span_tags": tags,
            "country": "US",
            "source": "openaddresses",
        }
        moved, reason = move_postcode(row)
        assert reason is None and moved is not None
        assert moved["raw"] == "1 Main St,11214 Brooklyn NY"
        assert span_texts(moved) == span_texts(row)
        assert (moved["span_starts"], moved["span_ends"]) == ([0, 2, 10, 16, 25], [1, 9, 15, 24, 27])

    def test_an_invalid_output_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from mailwoman_train.data.augment import postcode_move

        real = postcode_move._spans_ordered
        calls: list[int] = []

        def failing_on_output(length: int, spans: list[tuple[int, int]]) -> bool:
            calls.append(length)
            return real(length, spans) and len(calls) == 1

        monkeypatch.setattr(postcode_move, "_spans_ordered", failing_on_output)
        row = make_row(
            "123 Main St, Brooklyn, NY 11226",
            [
                ("house_number", "123"),
                ("street", "Main St"),
                ("locality", "Brooklyn"),
                ("region", "NY"),
                ("postcode", "11226"),
            ],
            "US",
        )
        assert move_postcode(row) == (None, SkipReason.INVALID_OUTPUT)


class TestTheKnob:
    def _row(self) -> dict[str, Any]:
        return make_row(
            "Via del Corso 12, 00186 Roma",
            [("street", "Via del Corso"), ("house_number", "12"), ("postcode", "00186"), ("locality", "Roma")],
            "IT",
        )

    def test_zero_leaves_the_stream_bit_identical(self) -> None:
        for seed in range(20):
            before, after = random.Random(seed), random.Random(seed)
            a = list(augment_row(self._row(), before, 0.3, 0.3, glue_prob=0.2, case_prob=0.2, ordinal_prob=0.2))
            b = list(
                augment_row(
                    self._row(), after, 0.3, 0.3, glue_prob=0.2, case_prob=0.2, ordinal_prob=0.2, postcode_move_prob=0.0
                )
            )
            assert a == b
            assert before.getstate() == after.getstate()

    def test_draws_last_so_earlier_copies_are_unchanged(self) -> None:
        rows_without = list(augment_row(self._row(), random.Random(5), 1.0, 1.0, case_prob=1.0))
        rows_with = list(augment_row(self._row(), random.Random(5), 1.0, 1.0, case_prob=1.0, postcode_move_prob=1.0))
        assert rows_with[: len(rows_without)] == rows_without
        assert rows_with[-1]["raw"] == "Via del Corso 12, Roma 00186"

    def test_is_an_additive_copy_and_counts_each_outcome(self) -> None:
        outcomes: Counter[str] = Counter()
        row = self._row()
        rows = list(
            augment_row(row, random.Random(1), 0.0, 0.0, postcode_move_prob=1.0, postcode_move_outcomes=outcomes)
        )
        assert rows[0] is row
        assert len(rows) == 2
        list(
            augment_row(
                {**row, "country": "JP"},
                random.Random(1),
                0.0,
                0.0,
                postcode_move_prob=1.0,
                postcode_move_outcomes=outcomes,
            )
        )
        assert outcomes == Counter({"moved": 1, SkipReason.NO_LOCALITY_FIELD: 1})

    @pytest.mark.parametrize("source", sorted(POSTCODE_MOVE_EXCLUDED_SOURCES))
    def test_synthetic_reordering_sources_are_excluded(self, source: str) -> None:
        policy = EmitPolicy(postcode_move_prob=1.0)
        assert [r["raw"] for r in emit_row({**self._row(), "source": source}, random.Random(1), policy)] == [
            "Via del Corso 12, 00186 Roma"
        ]
        assert len(list(emit_row(self._row(), random.Random(1), policy))) == 2

    def test_validation_never_moves_a_postcode(self) -> None:
        assert neutralized_for("val", TrainOnlyPolicy(postcode_move_prob=1.0)).postcode_move_prob == 0.0
        assert neutralized_for("train", TrainOnlyPolicy(postcode_move_prob=1.0)).postcode_move_prob == 1.0
