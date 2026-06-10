"""Contract tests for the affix-split relabel pass (#511).

The load-bearing property is BUILDER PARITY: split_street_span must agree with
build-street-affix-shard.mjs::parseStreet on every case, or the pass introduces a third
labeling and re-creates the contradiction it exists to cure.
"""

import json

import pytest

from .relabel import AffixRelabelLexicon, relabel_row, split_street_span

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
