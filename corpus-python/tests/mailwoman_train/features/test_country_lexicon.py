from __future__ import annotations

import re

from mailwoman_train.features.country_lexicon import (
    COUNTRY_AMBIGUOUS_BIT,
    COUNTRY_SURFACE_BIT,
    realign_country_to_pieces,
)
from mailwoman_train.features.gazetteer_anchor import GazetteerLexicon, gazetteer_char_paint
from mailwoman_train.types import PieceSpan

S = COUNTRY_SURFACE_BIT
A = COUNTRY_AMBIGUOUS_BIT

LEXICON = GazetteerLexicon(
    feature_dim=2,
    slots=("country_surface", "country_ambiguous"),
    bits={"country_surface": 1, "country_ambiguous": 2},
    max_ngram=4,
    entries={
        "united states of america": S,
        "united states": S,
        "america": S | A,
        "france": S,
        "georgia": S | A,
        "costa rica": S,
    },
    code_entries={
        "USA": S,
        "US": S,
        "CA": S | A,
        "FR": S,
    },
)


def painted_words(raw: str) -> dict[str, int]:
    char_bits, _ = gazetteer_char_paint(raw, LEXICON)
    out: dict[str, int] = {}
    for m in re.finditer(r"\S+", raw):
        word = m.group().strip(",.")
        for c in range(m.start(), m.end()):
            if raw[c].isalnum():
                out[word] = char_bits[c]
                break
    return out


def test_long_leading_form_paints_every_word_unambiguous():

    w = painted_words("United States of America, Wyoming, Cheyenne")
    assert w["United"] == S
    assert w["States"] == S
    assert w["of"] == S
    assert w["America"] == S
    assert w["Wyoming"] == 0
    assert w["Cheyenne"] == 0


def test_standalone_america_is_ambiguous():
    assert painted_words("123 America Avenue")["America"] == S | A


def test_homograph_clue_is_symmetric_and_flagged():
    expected = S | A
    assert painted_words("291 Hill Road, Atlanta, Georgia 30601")["Georgia"] == expected
    assert painted_words("772 Main Street, Tbilisi, Georgia")["Georgia"] == expected
    assert painted_words("291 Hill Road, Atlanta, Georgia 30601")["Atlanta"] == 0


def test_short_codes_match_uppercase_only():
    assert painted_words("New York, NY 10001, USA")["USA"] == S
    assert painted_words("meet us there")["us"] == 0
    assert painted_words("Toronto, ON, CA")["CA"] == S | A
    assert painted_words("Paris, FR")["FR"] == S


def test_multiword_country_paints_every_word_longest_first():
    w = painted_words("San Jose, Costa Rica")
    assert w["Costa"] == S
    assert w["Rica"] == S
    assert painted_words("Paris, France")["France"] == S


def test_realign_emits_surface_ambiguous_and_pads_zero():
    raw = "Tbilisi, Georgia"

    pieces = [
        PieceSpan(piece="Tbilisi", piece_id=10, char_begin=0, char_end=7),
        PieceSpan(piece=", ", piece_id=11, char_begin=7, char_end=9),
        PieceSpan(piece="Geo", piece_id=12, char_begin=9, char_end=12),
        PieceSpan(piece="rgia", piece_id=13, char_begin=12, char_end=16),
    ]
    feats, confs = realign_country_to_pieces(raw, pieces, LEXICON)
    assert len(feats) == 4 and len(confs) == 4
    assert feats[0] == [0.0, 0.0] and confs[0] == 0.0
    assert feats[1] == [0.0, 0.0] and confs[1] == 0.0
    assert feats[2] == [1.0, 1.0] and confs[2] == 1.0
    assert feats[3] == [1.0, 1.0] and confs[3] == 1.0


def test_realign_unambiguous_long_form_emits_surface_only():
    raw = "United States of America"

    pieces = [
        PieceSpan(piece="United", piece_id=1, char_begin=0, char_end=6),
        PieceSpan(piece=" States", piece_id=2, char_begin=6, char_end=13),
        PieceSpan(piece=" of", piece_id=3, char_begin=13, char_end=16),
        PieceSpan(piece=" America", piece_id=4, char_begin=16, char_end=24),
    ]
    feats, confs = realign_country_to_pieces(raw, pieces, LEXICON)
    for i in range(4):
        assert feats[i] == [1.0, 0.0]
        assert confs[i] == 1.0
