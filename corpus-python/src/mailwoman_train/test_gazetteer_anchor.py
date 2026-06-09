"""Gazetteer-anchor matcher tests (#464). Hermetic — inline lexicon fixture, no generated JSON.

The load-bearing assertions: the clue is SYMMETRIC on homographs (the same bits fire on "Georgia"
in Atlanta-context and Tbilisi-context — the MODEL disambiguates, the clue only says "look"),
short codes match uppercase-only (lowercase "in"/"ca" are English words), multi-word countries
paint every word, and the char→piece projection mirrors the postcode anchor's first-non-ws rule.
"""

from __future__ import annotations

from .gazetteer_anchor import (
    GazetteerLexicon,
    gazetteer_char_paint,
    realign_gazetteer_to_pieces,
    suppress_gazetteer_near_postcode,
)
from .tokenizer import PieceSpan

BITS = {"country": 1, "region": 2, "po_box": 4, "cedex": 8, "homograph": 16}
SLOTS = ("country", "region", "po_box", "cedex", "homograph")

LEXICON = GazetteerLexicon(
    feature_dim=5,
    slots=SLOTS,
    bits=BITS,
    max_ngram=3,
    entries={
        "georgia": BITS["country"] | BITS["region"] | BITS["homograph"],
        "jordan": BITS["country"] | BITS["region"] | BITS["homograph"],
        "france": BITS["country"],
        "costa rica": BITS["country"],
        "timor-leste": BITS["country"],
        "united states": BITS["country"],
        "po box": BITS["po_box"],
        "box": BITS["po_box"],
        "cedex": BITS["cedex"],
    },
    code_entries={
        "CA": BITS["country"] | BITS["region"] | BITS["homograph"],
        "IN": BITS["country"] | BITS["region"] | BITS["homograph"],
        "TX": BITS["region"],
        "FR": BITS["country"],
    },
)


def painted_words(raw: str) -> dict[str, int]:
    """Map each whitespace word (stripped) to the bitmask painted on its first kept char."""
    char_bits, _ = gazetteer_char_paint(raw, LEXICON)
    out: dict[str, int] = {}
    for m in __import__("re").finditer(r"\S+", raw):
        word = m.group().strip(",.")
        for c in range(m.start(), m.end()):
            if raw[c].isalnum():
                out[word] = char_bits[c]
                break
    return out


def test_homograph_clue_is_symmetric():
    us = painted_words("291 Hill Road, Atlanta, Georgia 30601")
    foreign = painted_words("772 Main Street, Tbilisi, Georgia")
    expected = BITS["country"] | BITS["region"] | BITS["homograph"]
    # Same surface, same clue, both contexts — disambiguation is the model's job.
    assert us["Georgia"] == expected
    assert foreign["Georgia"] == expected
    # Non-lexicon words carry no bits.
    assert us["Atlanta"] == 0
    assert us["30601"] == 0


def test_short_codes_match_uppercase_only():
    assert painted_words("Los Angeles, CA 90012")["CA"] == BITS["country"] | BITS["region"] | BITS["homograph"]
    # Lowercase "ca"/"in" are ordinary words — no clue.
    assert painted_words("turn left in paris")["in"] == 0
    assert painted_words("the ca registry")["ca"] == 0
    assert painted_words("Indianapolis, IN 46204")["IN"] == BITS["country"] | BITS["region"] | BITS["homograph"]


def test_multiword_country_paints_every_word():
    words = painted_words("San Jose, Costa Rica")
    assert words["Costa"] == BITS["country"]
    assert words["Rica"] == BITS["country"]
    # Longest-first: "United States" (2-gram) wins over any 1-gram fragment.
    words = painted_words("New York, NY 10001, United States")
    assert words["United"] == BITS["country"]
    assert words["States"] == BITS["country"]


def test_punctuation_stripped_for_matching():
    # Trailing comma must not break the match ("Georgia," → "georgia").
    words = painted_words("Tbilisi, Georgia, hello")
    assert words["Georgia"] == BITS["country"] | BITS["region"] | BITS["homograph"]
    # Hyphenated entry matches as one word.
    assert painted_words("Dili, Timor-Leste")["Timor-Leste"] == BITS["country"]


def test_po_box_and_cedex_clues():
    words = painted_words("PO Box 1234, Springfield")
    assert words["PO"] == BITS["po_box"]
    assert words["Box"] == BITS["po_box"]
    # The clue fires on "Box Canyon Rd" too — by design. The model reads context; the clue only
    # marks lexicon membership (model-first: a hint, never a verdict).
    assert painted_words("12 Box Canyon Rd")["Box"] == BITS["po_box"]
    assert painted_words("75008 PARIS CEDEX 02")["CEDEX"] == BITS["cedex"]


def test_choreography_zeros_clue_adjacent_to_postcode_anchor():
    # "Los Angeles, CA 90012": pieces [LA, CA(region clue, bits=19), 90012(postcode anchor conf=1)].
    feats = [[0, 0, 0, 0, 0], [1, 1, 0, 0, 1], [0, 0, 0, 0, 0]]
    confs = [0.0, 1.0, 0.0]
    anchor_conf = [0.0, 0.0, 1.0]  # postcode anchor fires on the ZIP piece
    out_f, out_c = suppress_gazetteer_near_postcode(feats, confs, anchor_conf, feature_dim=5, window=1)
    # The CA clue (index 1) is adjacent to the postcode anchor (index 2) → zeroed.
    assert out_f[1] == [0, 0, 0, 0, 0]
    assert out_c[1] == 0.0
    # A clue NOT adjacent to a postcode anchor is untouched.
    feats2 = [[1, 1, 0, 0, 1], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]
    confs2 = [1.0, 0.0, 0.0]
    anchor2 = [0.0, 0.0, 1.0]  # postcode 2 pieces away from the clue
    of2, oc2 = suppress_gazetteer_near_postcode(feats2, confs2, anchor2, feature_dim=5, window=1)
    assert of2[0] == [1, 1, 0, 0, 1] and oc2[0] == 1.0


def test_realign_projects_first_nonws_char_and_pads_zero():
    raw = "Tbilisi, Georgia"
    #              0123456789012345
    pieces = [
        PieceSpan(piece="Tbilisi", piece_id=10, char_begin=0, char_end=7),
        PieceSpan(piece=", ", piece_id=11, char_begin=7, char_end=9),
        PieceSpan(piece="Geo", piece_id=12, char_begin=9, char_end=12),
        PieceSpan(piece="rgia", piece_id=13, char_begin=12, char_end=16),
    ]
    feats, confs = realign_gazetteer_to_pieces(raw, pieces, LEXICON)
    assert len(feats) == 4 and len(confs) == 4
    assert feats[0] == [0.0] * 5 and confs[0] == 0.0  # Tbilisi: no clue
    # ", " piece: first non-ws char is "," (stripped → unpainted) → zero.
    assert feats[1] == [0.0] * 5 and confs[1] == 0.0
    # Both Georgia sub-pieces inherit the homograph clue.
    expected = [1.0, 1.0, 0.0, 0.0, 1.0]  # country, region, _, _, homograph
    assert feats[2] == expected and confs[2] == 1.0
    assert feats[3] == expected and confs[3] == 1.0
