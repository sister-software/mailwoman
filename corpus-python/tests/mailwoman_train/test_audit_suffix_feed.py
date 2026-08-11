"""Terminal-only feed audit (#1569) — reconstruction of the 2026-08-09 250k selectable-feed
audit as a permanent module (the original was ad-hoc and not committed).

Definitions mirror ``classifySuffixBoundaryStreet`` (corpus/src/shard-recipes/street-affix.ts)
via the v2 lexicon's vocabulary: a row's street-family group (street span + immediately
following authored suffix span) is assembled into surface words;

- ``terminal-only``  — trailing word is a true (non-name-prone) suffix AND the word before it
  is name-prone ('Blue Hill Rd', 'Menlo Park' + 'Road');
- ``terminal-contrast`` — the trailing word itself is name-prone ('Sutton Hollow').

Correct after the load-time relabel = the group's LAST word carries ``street_suffix`` and the
word before it carries ``street``. Classification always uses the v2 (classify) lexicon; the
RELABEL lexicon is the variable under test — v1 reproduces the 2026-08-09 baseline behavior
(ordinary monolithic carriers stay wrong), v2 licenses the positional split.
"""

from __future__ import annotations

from mailwoman_train.audit_suffix_feed import classify_street_group, evaluate_row
from mailwoman_train.relabel import AffixRelabelLexicon

LEX_V2 = AffixRelabelLexicon(
    directionals={"w": "W", "west": "W"},
    suffixes={
        "rd": "ROAD",
        "road": "ROAD",
        "ave": "AVENUE",
        "avenue": "AVENUE",
        "park": "PARK",
        "hollow": "HOLLOW",
        "mill": "MILL",
    },
    version="test-v2",
    name_prone=frozenset({"PARK", "HOLLOW", "MILL"}),
)
LEX_V1 = AffixRelabelLexicon(
    directionals=LEX_V2.directionals,
    suffixes=LEX_V2.suffixes,
    version="test-v1",
)


class TestClassify:
    def test_terminal_only(self):
        assert classify_street_group(["Menlo", "Park", "Road"], LEX_V2) == "terminal-only"
        assert classify_street_group(["Cider", "Mill", "Rd"], LEX_V2) == "terminal-only"

    def test_terminal_contrast(self):
        assert classify_street_group(["Sutton", "Hollow"], LEX_V2) == "terminal-contrast"

    def test_plain_suffix_street_is_neither(self):
        assert classify_street_group(["Maple", "Road"], LEX_V2) is None

    def test_no_suffix_is_neither(self):
        assert classify_street_group(["Broadway"], LEX_V2) is None
        assert classify_street_group(["Hauptstraße", "Nord"], LEX_V2) is None


class TestEvaluateRow:
    def _monolithic(self) -> dict:
        return {
            "tokens": ["64", "Industrial", "Park", "Rd", "Alburgh"],
            "labels": ["B-house_number", "B-street", "I-street", "I-street", "B-locality"],
            "source": "tiger",
            "country": "US",
        }

    def _authored_split(self) -> dict:
        return {
            "tokens": ["Menlo", "Park", "Road"],
            "labels": ["B-street", "I-street", "B-street_suffix"],
            "source": "synth-suffix-boundary",
            "country": "US",
        }

    def test_monolithic_carrier_is_wrong_under_v1_relabel(self):
        results = evaluate_row(self._monolithic(), classify_lex=LEX_V2, relabel_lex=LEX_V1)
        assert results == [("terminal-only", False)]

    def test_monolithic_carrier_is_corrected_under_v2_relabel(self):
        results = evaluate_row(self._monolithic(), classify_lex=LEX_V2, relabel_lex=LEX_V2)
        assert results == [("terminal-only", True)]

    def test_authored_split_carrier_is_correct_under_both(self):
        for relabel_lex in (LEX_V1, LEX_V2):
            assert evaluate_row(self._authored_split(), classify_lex=LEX_V2, relabel_lex=relabel_lex) == [
                ("terminal-only", True)
            ]

    def test_contrast_row_splits_at_the_final_word_under_both(self):
        row = {
            "tokens": ["Sutton", "Hollow"],
            "labels": ["B-street", "I-street"],
            "source": "tiger",
            "country": "US",
        }
        for relabel_lex in (LEX_V1, LEX_V2):
            assert evaluate_row(dict(row), classify_lex=LEX_V2, relabel_lex=relabel_lex) == [
                ("terminal-contrast", True)
            ]

    def test_row_without_street_family_yields_nothing(self):
        row = {
            "tokens": ["Springfield"],
            "labels": ["B-locality"],
            "source": "tiger",
            "country": "US",
        }
        assert evaluate_row(row, classify_lex=LEX_V2, relabel_lex=LEX_V2) == []

    def test_evaluate_does_not_mutate_the_caller_row(self):
        row = self._monolithic()
        before = list(row["labels"])
        evaluate_row(row, classify_lex=LEX_V2, relabel_lex=LEX_V2)
        assert row["labels"] == before
