"""Tests for the shaped-painting anchor path (#220/#723, ``anchor_paint_mode="shaped"``).

The #723 root cause: training painted the postcode anchor ONLY on gold ``postcode`` spans, but
inference paints on postcode-SHAPED spans — so the model never trained on the anchor firing on a
house-number-that-looks-like-a-ZIP and faceplanted on "12345 Main St". The shaped path closes that
train/inference gap. The load-bearing assertion here is the CONTRAST: gold paints nothing on such a
house number; shaped paints the anchor on it (the training signal the model needs to learn to override).
"""

from __future__ import annotations

from mailwoman_train.postcode_shapes import collect_matches
from mailwoman_train.tokenizer import (
    ANCHOR_FEATURE_DIM,
    PieceSpan,
    anchor_feature_vector,
    realign_anchor_to_pieces,
    realign_anchor_to_pieces_shaped,
)


def _piece(text: str, begin: int, end: int) -> PieceSpan:
    return PieceSpan(piece=text, piece_id=0, char_begin=begin, char_end=end)


# ---- collect_matches: the shape detector (mirror of neural/postcode-repair.ts) ----


def test_collect_matches_detects_num5():
    ms = collect_matches("Strasse 12 10115 Berlin")
    assert [(m.start, m.end) for m in ms] == [(11, 16)]  # "10115"


def test_collect_matches_zip4_beats_num5_tail():
    # "94610-2737" is one ZIP4 match — longest-match-wins must NOT split it into NUM5 + a tail.
    text = "123 Main St San Francisco CA 94610-2737"
    z0 = text.index("94610-2737")
    z1 = z0 + len("94610-2737")
    ms = collect_matches(text)
    spans = [(m.start, m.end, m.kind) for m in ms]
    assert (z0, z1, "numeric") in spans  # the full ZIP+4 as ONE match
    assert all(not (s >= z0 and e <= z1 and (s, e) != (z0, z1)) for s, e, _ in spans)  # no sub-span


def test_collect_matches_house_number_shape():
    # The #723 trigger: a leading 5-digit house number IS postcode-shaped (NUM5).
    ms = collect_matches("12345 Main St")
    assert [(m.start, m.end) for m in ms] == [(0, 5)]


# ---- the contrast that IS the fix: gold vs shaped on a house-number-that-looks-like-a-ZIP ----

RAW_H = "12345 Main St"
TOKENS_H = ["12345", "Main", "St"]
LABELS_H = ["B-house_number", "B-street", "I-street"]  # 12345 is a HOUSE NUMBER here
PIECES_H = [_piece("12345", 0, 5), _piece("Main", 6, 10), _piece("St", 11, 13)]
# 12345 is also a real US ZIP (Schenectady NY) — so it IS in the anchor lookup.
LOOKUP_H = {"12345": ({"US": 1.0}, 42.81, -73.93)}


def test_gold_path_paints_nothing_on_leading_house_number():
    # GOLD: 12345 is labeled house_number, not postcode → the anchor never fires at TRAIN.
    feats, confs = realign_anchor_to_pieces(RAW_H, TOKENS_H, LABELS_H, PIECES_H, LOOKUP_H)
    assert confs == [0.0, 0.0, 0.0]
    assert all(f == [0.0] * ANCHOR_FEATURE_DIM for f in feats)


def test_shaped_path_paints_anchor_on_leading_house_number():
    # SHAPED: 12345 is postcode-SHAPED and in the lookup → the anchor FIRES on the house number,
    # exactly as it does at inference. THIS is the #723 training signal the gold path withheld.
    feats, confs = realign_anchor_to_pieces_shaped(RAW_H, PIECES_H, LOOKUP_H)
    assert confs == [1.0, 0.0, 0.0]
    assert feats[0] == anchor_feature_vector({"US": 1.0}, 42.81, -73.93)
    assert feats[1] == [0.0] * ANCHOR_FEATURE_DIM and feats[2] == [0.0] * ANCHOR_FEATURE_DIM


def test_shaped_path_misses_non_lookup_shape():
    # A postcode-shaped token NOT in the lookup (99999 is no real ZIP) paints nothing — like inference.
    feats, confs = realign_anchor_to_pieces_shaped("99999 Main St", PIECES_H, {})
    assert confs == [0.0, 0.0, 0.0]
    assert all(f == [0.0] * ANCHOR_FEATURE_DIM for f in feats)


def test_shaped_matches_gold_when_postcode_is_in_position():
    # Sanity: on a REAL postcode in postcode position, shaped and gold paint the SAME pieces (the only
    # difference between modes is WHERE detection comes from, never WHAT lands).
    raw = "Strasse 12 10115 Berlin"
    pieces = [_piece("Strasse", 0, 7), _piece("12", 8, 10), _piece("10115", 11, 16), _piece("Berlin", 17, 23)]
    lookup = {"10115": ({"DE": 1.0}, 52.53, 13.40)}
    g_feats, g_confs = realign_anchor_to_pieces(
        raw,
        ["Strasse", "12", "10115", "Berlin"],
        ["B-street", "B-house_number", "B-postcode", "B-locality"],
        pieces,
        lookup,
    )
    s_feats, s_confs = realign_anchor_to_pieces_shaped(raw, pieces, lookup)
    assert g_confs == s_confs
    assert g_feats == s_feats
