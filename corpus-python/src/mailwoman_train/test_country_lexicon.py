"""Country-lexicon matcher tests (#1104). Hermetic — inline lexicon fixture, no generated JSON.

These assertions MIRROR neural/country-inference.test.ts — if the Python matcher drifts from the TS
one, the model sees different clues at inference than it trained on. The inline lexicon matches the TS
fixture exactly.

The critical properties: the LONG leading form ("united states of america") paints every word as an
UNAMBIGUOUS country surface (the #1104 WOF-admin case the tagger reads as a leading street);
homographs ("georgia", "CA") fire country_surface AND country_ambiguous symmetrically (the model
disambiguates via context); short codes match uppercase-only ("us" the word ≠ "US"); and the
char→piece projection mirrors the anchor's first-non-ws rule.
"""

from __future__ import annotations

import re

from .country_lexicon import (
    COUNTRY_AMBIGUOUS_BIT,
    COUNTRY_SURFACE_BIT,
    GazetteerLexicon,
    realign_country_to_pieces,
)
from .gazetteer_anchor import gazetteer_char_paint
from .tokenizer import PieceSpan

S = COUNTRY_SURFACE_BIT  # 1
A = COUNTRY_AMBIGUOUS_BIT  # 2

LEXICON = GazetteerLexicon(
    feature_dim=2,
    slots=("country_surface", "country_ambiguous"),
    bits={"country_surface": 1, "country_ambiguous": 2},
    max_ngram=4,
    entries={
        "united states of america": S,
        "united states": S,
        "america": S | A,  # common-word surface → ambiguous
        "france": S,
        "georgia": S | A,  # homograph with a US region → ambiguous
        "costa rica": S,
    },
    code_entries={
        "USA": S,
        "US": S,
        "CA": S | A,  # Canada code / California abbreviation → ambiguous
        "FR": S,
    },
)


def painted_words(raw: str) -> dict[str, int]:
    """Map each whitespace word (stripped) to the bitmask painted on its first kept char."""
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
    # The #1104 WOF-admin case: the 4-token phrase the learned tagger reads as a leading street.
    w = painted_words("United States of America, Wyoming, Cheyenne")
    assert w["United"] == S
    assert w["States"] == S
    assert w["of"] == S
    assert w["America"] == S  # inside the phrase → NOT the standalone ambiguous "america"
    assert w["Wyoming"] == 0  # a US region, not a country surface
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
    assert painted_words("Toronto, ON, CA")["CA"] == S | A  # Canada / California homograph
    assert painted_words("Paris, FR")["FR"] == S


def test_multiword_country_paints_every_word_longest_first():
    w = painted_words("San Jose, Costa Rica")
    assert w["Costa"] == S
    assert w["Rica"] == S
    assert painted_words("Paris, France")["France"] == S


def test_realign_emits_surface_ambiguous_and_pads_zero():
    raw = "Tbilisi, Georgia"
    #              0123456789012345
    pieces = [
        PieceSpan(piece="Tbilisi", piece_id=10, char_begin=0, char_end=7),
        PieceSpan(piece=", ", piece_id=11, char_begin=7, char_end=9),
        PieceSpan(piece="Geo", piece_id=12, char_begin=9, char_end=12),
        PieceSpan(piece="rgia", piece_id=13, char_begin=12, char_end=16),
    ]
    feats, confs = realign_country_to_pieces(raw, pieces, LEXICON)
    assert len(feats) == 4 and len(confs) == 4
    assert feats[0] == [0.0, 0.0] and confs[0] == 0.0  # Tbilisi: no clue
    assert feats[1] == [0.0, 0.0] and confs[1] == 0.0  # ", " → first non-ws is "," (stripped)
    assert feats[2] == [1.0, 1.0] and confs[2] == 1.0  # Georgia: surface + ambiguous
    assert feats[3] == [1.0, 1.0] and confs[3] == 1.0


def test_realign_unambiguous_long_form_emits_surface_only():
    raw = "United States of America"
    #      0         1         2
    #      0123456789012345678901234
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
