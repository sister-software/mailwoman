"""Contract tests for the affix-split relabel pass (#511).

The load-bearing property is BUILDER PARITY: split_street_span must agree with
build-street-affix-shard.mjs::parseStreet on every case, or the pass introduces a third
labeling and re-creates the contradiction it exists to cure.
"""

import json

import pytest

from .relabel import AffixRelabelLexicon, relabel_row, relabel_spans, split_street_span

LEX = AffixRelabelLexicon(
    directionals={
        "n": "N", "north": "N", "s": "S", "south": "S", "e": "E", "east": "E", "w": "W", "west": "W",
        "ne": "NE", "northeast": "NE", "nw": "NW", "northwest": "NW",
        "se": "SE", "southeast": "SE", "sw": "SW", "southwest": "SW",
    },
    suffixes={
        "st": "STREET", "street": "STREET", "ave": "AVENUE", "avenue": "AVENUE",
        "rd": "ROAD", "road": "ROAD", "dr": "DRIVE", "drive": "DRIVE",
        "park": "PARK", "hill": "HILL", "ln": "LANE", "lane": "LANE",
    },
    version="test",
)


def split(text: str):
    return split_street_span(text.split(), LEX)


class TestSplitBuilderParity:
    def test_prefix_name_suffix(self):
        assert split("N Main St") == (1, 1)

    def test_suffix_only(self):
        assert split("Weaver Lane") == (0, 1)

    def test_case_insensitive(self):
        assert split("SOUTH WEAVER LANE") == (1, 1)

    def test_single_word_never_splits(self):
        assert split("Broadway") is None

    def test_no_suffix_no_split(self):
        # Trailing directional is NOT a suffix — the builder requires a trailing suffix.
        assert split("South County Road 175 West") is None

    def test_directional_is_the_name(self):
        # "North St": the candidate name "North" is itself directional-shaped, so the builder's
        # isSuffixOrDirectional rejects the whole split — parity means we reject too.
        assert split("North St") is None

    def test_affix_shaped_name_rejected(self):
        # Builder parity: "W Park Ave" gets NO split because the name "Park" is a suffix variant.
        assert split("W Park Ave") is None

    def test_multiword_name_with_trailing_suffix_shape_rejected(self):
        # isSuffixOrDirectional checks the name's TRAILING word: "Cherry Hill" ends suffix-shaped.
        assert split("W Cherry Hill Rd") is None

    def test_period_not_stripped(self):
        # Conservative parity: "St." is not in the lookup, same as the TS matcher.
        assert split("Main St.") is None

    def test_ordinal_name(self):
        assert split("E 161st St") == (1, 1)

    def test_two_word_directional_leading(self):
        # "W St" — prefix split needs >2 words; "W" is not a suffix, so no suffix match either.
        assert split("W St") is None

    def test_intl_no_op(self):
        assert split("Hauptstraße") is None
        assert split("Avenue des Champs-Élysées") is None  # leading suffix-shape, trailing no match


class TestRelabelRow:
    def test_splits_bio_labels(self):
        row = {
            "tokens": ["1234", "SE", "Division", "St", "Portland", "OR", "97202"],
            "labels": ["B-house_number", "B-street", "I-street", "I-street", "B-locality", "B-region", "B-postcode"],
        }
        assert relabel_row(row, LEX) is True
        assert row["labels"] == [
            "B-house_number", "B-street_prefix", "B-street", "B-street_suffix",
            "B-locality", "B-region", "B-postcode",
        ]

    def test_multiword_name_keeps_bio_chain(self):
        row = {
            "tokens": ["N", "Dixie", "Box", "Road"],
            "labels": ["B-street", "I-street", "I-street", "I-street"],
        }
        assert relabel_row(row, LEX) is True
        assert row["labels"] == ["B-street_prefix", "B-street", "I-street", "B-street_suffix"]

    def test_untouched_when_no_suffix(self):
        row = {
            "tokens": ["4550", "South", "County", "Trail", "175", "West"],
            "labels": ["B-house_number", "B-street", "I-street", "I-street", "I-street", "I-street"],
        }
        assert relabel_row(row, LEX) is False
        assert row["labels"][1:] == ["B-street", "I-street", "I-street", "I-street", "I-street"]

    def test_non_street_spans_untouched(self):
        row = {
            "tokens": ["Main", "St", "Springfield"],
            "labels": ["B-street", "I-street", "B-locality"],
        }
        relabel_row(row, LEX)
        assert row["labels"][2] == "B-locality"

    def test_handles_multiple_street_spans(self):
        # Intersection-style rows carry two street spans.
        row = {
            "tokens": ["N", "Main", "St", "and", "W", "Oak", "Ave"],
            "labels": ["B-street", "I-street", "I-street", "O", "B-street", "I-street", "I-street"],
        }
        assert relabel_row(row, LEX) is True
        assert row["labels"] == [
            "B-street_prefix", "B-street", "B-street_suffix", "O",
            "B-street_prefix", "B-street", "B-street_suffix",
        ]


class TestRelabelSpans:
    """Char-arithmetic re-target of the #519 span triple — the v0.5.0 form of the pass."""

    @staticmethod
    def _slices(row):
        return [
            (t, row["raw"][s:e])
            for s, e, t in zip(row["span_starts"], row["span_ends"], row["span_tags"])
        ]

    def test_splits_street_span_by_char_arithmetic(self):
        row = {
            "raw": "1234 SE Division St, Portland, OR 97202",
            "tokens": ["1234", "SE", "Division", "St", "Portland", "OR", "97202"],
            "labels": ["B-house_number", "B-street", "I-street", "I-street", "B-locality", "B-region", "B-postcode"],
            "span_starts": [0, 5, 21, 31, 34],
            "span_ends": [4, 19, 29, 33, 39],
            "span_tags": ["house_number", "street", "locality", "region", "postcode"],
        }
        assert relabel_row(row, LEX) is True
        assert self._slices(row) == [
            ("house_number", "1234"),
            ("street_prefix", "SE"),
            ("street", "Division"),
            ("street_suffix", "St"),
            ("locality", "Portland"),
            ("region", "OR"),
            ("postcode", "97202"),
        ]
        # Token labels split in lockstep (transitional — both representations ride).
        assert row["labels"][1:4] == ["B-street_prefix", "B-street", "B-street_suffix"]

    def test_multiword_name_span(self):
        row = {
            "raw": "N Dixie Box Road",
            "tokens": ["N", "Dixie", "Box", "Road"],
            "labels": ["B-street", "I-street", "I-street", "I-street"],
            "span_starts": [0],
            "span_ends": [16],
            "span_tags": ["street"],
        }
        assert relabel_row(row, LEX) is True
        assert self._slices(row) == [
            ("street_prefix", "N"),
            ("street", "Dixie Box"),
            ("street_suffix", "Road"),
        ]

    def test_no_split_leaves_spans_untouched(self):
        row = {
            "raw": "South County Trail 175 West",
            "tokens": ["South", "County", "Trail", "175", "West"],
            "labels": ["B-street", "I-street", "I-street", "I-street", "I-street"],
            "span_starts": [0],
            "span_ends": [27],
            "span_tags": ["street"],
        }
        assert relabel_spans(row, LEX) is False
        assert row["span_starts"] == [0] and row["span_ends"] == [27] and row["span_tags"] == ["street"]

    def test_dotted_suffix_is_conservative_on_the_span_path(self):
        # "Main St.": the corpus tokenizer dropped the period, so the TOKEN path sees "St" and
        # splits; the span path sees the whitespace word "St." (builder parity: parseStreet
        # splits raw words, "St." is not in the lexicon) and leaves the span whole. The span path
        # is the v0.5.0 source of truth — conservative beats a third labeling.
        row = {
            "raw": "Main St.",
            "tokens": ["Main", "St"],
            "labels": ["B-street", "I-street"],
            "span_starts": [0],
            "span_ends": [8],
            "span_tags": ["street"],
        }
        relabel_row(row, LEX)
        assert row["span_tags"] == ["street"]
        assert row["labels"] == ["B-street", "B-street_suffix"]  # token path split (legacy semantics)

    def test_multiple_street_spans_intersection_style(self):
        row = {
            "raw": "N Main St and W Oak Ave",
            "tokens": ["N", "Main", "St", "and", "W", "Oak", "Ave"],
            "labels": ["B-street", "I-street", "I-street", "O", "B-street", "I-street", "I-street"],
            "span_starts": [0, 14],
            "span_ends": [9, 23],
            "span_tags": ["street", "street"],
        }
        assert relabel_row(row, LEX) is True
        assert self._slices(row) == [
            ("street_prefix", "N"),
            ("street", "Main"),
            ("street_suffix", "St"),
            ("street_prefix", "W"),
            ("street", "Oak"),
            ("street_suffix", "Ave"),
        ]

    def test_replaces_lists_instead_of_mutating(self):
        starts = [0]
        row = {
            "raw": "Weaver Lane",
            "tokens": ["Weaver", "Lane"],
            "labels": ["B-street", "I-street"],
            "span_starts": starts,
            "span_ends": [11],
            "span_tags": ["street"],
        }
        assert relabel_spans(row, LEX) is True
        assert starts == [0]  # the caller's original list is not mutated through
        assert row["span_starts"] == [0, 7]

    def test_legacy_row_without_spans_is_a_no_op(self):
        row = {"tokens": ["Weaver", "Lane"], "labels": ["B-street", "I-street"]}
        assert relabel_spans(row, LEX) is False
        assert relabel_row(row, LEX) is True  # token path still fires

    def test_partial_triple_raises(self):
        row = {
            "raw": "Weaver Lane",
            "tokens": ["Weaver", "Lane"],
            "labels": ["B-street", "I-street"],
            "span_starts": [0],
        }
        with pytest.raises(ValueError, match="partial char-offset span triple"):
            relabel_spans(row, LEX)


class TestLexiconLoading:
    def test_loud_on_missing_file(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            AffixRelabelLexicon.load(tmp_path / "nope.json")

    def test_loud_on_missing_keys(self, tmp_path):
        p = tmp_path / "bad.json"
        p.write_text(json.dumps({"directionals": {"n": "N"}}))
        with pytest.raises(ValueError, match="missing key"):
            AffixRelabelLexicon.load(p)

    def test_loud_on_empty_vocab(self, tmp_path):
        p = tmp_path / "empty.json"
        p.write_text(json.dumps({"directionals": {}, "suffixes": {}, "version": "x"}))
        with pytest.raises(ValueError, match="empty vocab"):
            AffixRelabelLexicon.load(p)
