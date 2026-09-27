from __future__ import annotations

from mailwoman_train.features.gazetteer_anchor import (
    GazetteerLexicon,
    gazetteer_char_paint,
    realign_gazetteer_to_pieces,
    suppress_gazetteer_near_postcode,
)
from mailwoman_train.types import PieceSpan

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

    assert us["Georgia"] == expected
    assert foreign["Georgia"] == expected

    assert us["Atlanta"] == 0
    assert us["30601"] == 0


def test_short_codes_match_uppercase_only():
    assert painted_words("Los Angeles, CA 90012")["CA"] == BITS["country"] | BITS["region"] | BITS["homograph"]

    assert painted_words("turn left in paris")["in"] == 0
    assert painted_words("the ca registry")["ca"] == 0
    assert painted_words("Indianapolis, IN 46204")["IN"] == BITS["country"] | BITS["region"] | BITS["homograph"]


def test_multiword_country_paints_every_word():
    words = painted_words("San Jose, Costa Rica")
    assert words["Costa"] == BITS["country"]
    assert words["Rica"] == BITS["country"]

    words = painted_words("New York, NY 10001, United States")
    assert words["United"] == BITS["country"]
    assert words["States"] == BITS["country"]


def test_punctuation_stripped_for_matching():

    words = painted_words("Tbilisi, Georgia, hello")
    assert words["Georgia"] == BITS["country"] | BITS["region"] | BITS["homograph"]

    assert painted_words("Dili, Timor-Leste")["Timor-Leste"] == BITS["country"]


def test_po_box_and_cedex_clues():
    words = painted_words("PO Box 1234, Springfield")
    assert words["PO"] == BITS["po_box"]
    assert words["Box"] == BITS["po_box"]

    assert painted_words("12 Box Canyon Rd")["Box"] == BITS["po_box"]
    assert painted_words("75008 PARIS CEDEX 02")["CEDEX"] == BITS["cedex"]


def test_choreography_zeros_clue_adjacent_to_postcode_anchor():

    feats = [[0, 0, 0, 0, 0], [1, 1, 0, 0, 1], [0, 0, 0, 0, 0]]
    confs = [0.0, 1.0, 0.0]
    anchor_conf = [0.0, 0.0, 1.0]
    out_f, out_c = suppress_gazetteer_near_postcode(feats, confs, anchor_conf, feature_dim=5, window=1)

    assert out_f[1] == [0, 0, 0, 0, 0]
    assert out_c[1] == 0.0

    feats2 = [[1, 1, 0, 0, 1], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]
    confs2 = [1.0, 0.0, 0.0]
    anchor2 = [0.0, 0.0, 1.0]
    of2, oc2 = suppress_gazetteer_near_postcode(feats2, confs2, anchor2, feature_dim=5, window=1)
    assert of2[0] == [1, 1, 0, 0, 1] and oc2[0] == 1.0


def test_realign_projects_first_nonws_char_and_pads_zero():
    raw = "Tbilisi, Georgia"

    pieces = [
        PieceSpan(piece="Tbilisi", piece_id=10, char_begin=0, char_end=7),
        PieceSpan(piece=", ", piece_id=11, char_begin=7, char_end=9),
        PieceSpan(piece="Geo", piece_id=12, char_begin=9, char_end=12),
        PieceSpan(piece="rgia", piece_id=13, char_begin=12, char_end=16),
    ]
    feats, confs = realign_gazetteer_to_pieces(raw, pieces, LEXICON)
    assert len(feats) == 4 and len(confs) == 4
    assert feats[0] == [0.0] * 5 and confs[0] == 0.0

    assert feats[1] == [0.0] * 5 and confs[1] == 0.0

    expected = [1.0, 1.0, 0.0, 0.0, 1.0]
    assert feats[2] == expected and confs[2] == 1.0
    assert feats[3] == expected and confs[3] == 1.0
