"""Tests for the shaped-painting anchor path (``anchor_paint_mode="shaped"``), which paints a postcode anchor on postcode-shaped spans so a house-number-that-looks-like-a-ZIP gets the signal gold training withholds."""

from __future__ import annotations

from mailwoman_train.features.postcode_shapes import collect_matches
from mailwoman_train.tokenizer import (
    ANCHOR_FEATURE_DIM,
    anchor_feature_vector,
    realign_anchor_to_pieces,
    realign_anchor_to_pieces_shaped,
)
from mailwoman_train.types import PieceSpan


def _piece(text: str, begin: int, end: int) -> PieceSpan:
    return PieceSpan(piece=text, piece_id=0, char_begin=begin, char_end=end)


def test_collect_matches_detects_num5():
    ms = collect_matches("Strasse 12 10115 Berlin")
    assert [(m.start, m.end) for m in ms] == [(11, 16)]


def test_collect_matches_zip4_beats_num5_tail():
    # Longest-match-wins: "94610-2737" must stay one match rather than NUM5 + a tail.
    text = "123 Main St San Francisco CA 94610-2737"
    z0 = text.index("94610-2737")
    z1 = z0 + len("94610-2737")
    ms = collect_matches(text)
    spans = [(m.start, m.end, m.kind) for m in ms]
    assert (z0, z1, "numeric") in spans
    assert all(not (s >= z0 and e <= z1 and (s, e) != (z0, z1)) for s, e, _ in spans)


def test_collect_matches_house_number_shape():
    ms = collect_matches("12345 Main St")
    assert [(m.start, m.end) for m in ms] == [(0, 5)]


RAW_H = "12345 Main St"
TOKENS_H = ["12345", "Main", "St"]
LABELS_H = ["B-house_number", "B-street", "I-street"]
PIECES_H = [_piece("12345", 0, 5), _piece("Main", 6, 10), _piece("St", 11, 13)]
# 12345 is also a real US ZIP (Schenectady NY) — so it is in the anchor lookup.
LOOKUP_H = {"12345": ({"US": 1.0}, 42.81, -73.93)}


def test_gold_path_paints_nothing_on_leading_house_number():
    feats, confs = realign_anchor_to_pieces(RAW_H, TOKENS_H, LABELS_H, PIECES_H, LOOKUP_H)
    assert confs == [0.0, 0.0, 0.0]
    assert all(f == [0.0] * ANCHOR_FEATURE_DIM for f in feats)


def test_shaped_path_paints_anchor_on_leading_house_number():
    feats, confs = realign_anchor_to_pieces_shaped(RAW_H, PIECES_H, LOOKUP_H)
    assert confs == [1.0, 0.0, 0.0]
    assert feats[0] == anchor_feature_vector({"US": 1.0}, 42.81, -73.93)
    assert feats[1] == [0.0] * ANCHOR_FEATURE_DIM and feats[2] == [0.0] * ANCHOR_FEATURE_DIM


def test_shaped_path_misses_non_lookup_shape():
    feats, confs = realign_anchor_to_pieces_shaped("99999 Main St", PIECES_H, {})
    assert confs == [0.0, 0.0, 0.0]
    assert all(f == [0.0] * ANCHOR_FEATURE_DIM for f in feats)


RAW_GB = "Buckingham Palace, London SW1A 2AA"
# Pieces that split the unit across the space, the geometry a wrong paint extent shows up in.
PIECES_GB = [
    _piece("Buckingham", 0, 10),
    _piece("Palace", 11, 17),
    _piece("London", 19, 25),
    _piece("SW1A", 26, 30),
    _piece("2AA", 31, 34),
]


def test_shaped_paints_a_gb_unit_from_the_space_stripped_key():
    # The lookup key is space-stripped (`SW1A2AA`) while the shaped span includes the space,
    # matching `neural/anchor-inference.ts`'s `spanMode: "shaped"`.
    lookup = {"SW1A2AA": ({"GB": 1.0}, 51.50354, -0.1277)}
    feats, confs = realign_anchor_to_pieces_shaped(RAW_GB, PIECES_GB, lookup)
    assert confs == [0.0, 0.0, 0.0, 1.0, 1.0]
    gb = anchor_feature_vector({"GB": 1.0}, 51.50354, -0.1277)
    assert feats[3] == gb and feats[4] == gb


def test_shaped_falls_back_to_the_gb_outward_district():
    # An unknown unit paints the whole unit span from its outward district — 215 of the 217 misses
    # `synth-gb-v1` has in 200,000 rows.
    lookup = {"SW1A": ({"GB": 1.0}, 51.50452, -0.13216)}
    feats, confs = realign_anchor_to_pieces_shaped(RAW_GB, PIECES_GB, lookup)
    assert confs == [0.0, 0.0, 0.0, 1.0, 1.0]
    outward = anchor_feature_vector({"GB": 1.0}, 51.50452, -0.13216)
    assert feats[3] == outward and feats[4] == outward


def test_the_unit_key_wins_over_the_outward_key():
    lookup = {
        "SW1A2AA": ({"GB": 1.0}, 51.50354, -0.1277),
        "SW1A": ({"GB": 1.0}, 51.50452, -0.13216),
    }
    feats, _ = realign_anchor_to_pieces_shaped(RAW_GB, PIECES_GB, lookup)
    assert feats[3] == anchor_feature_vector({"GB": 1.0}, 51.50354, -0.1277)


def test_the_outward_fallback_is_inert_for_a_five_digit_lookup():
    # The GB shape guard rejects a numeric code before the outward probe, so the fallback cannot
    # anchor house numbers from two-digit prefixes.
    feats, confs = realign_anchor_to_pieces_shaped(RAW_H, PIECES_H, {"12": ({"US": 1.0}, 42.81, -73.93)})
    assert confs == [0.0, 0.0, 0.0]
    assert all(f == [0.0] * ANCHOR_FEATURE_DIM for f in feats)


def test_shaped_matches_gold_when_postcode_is_in_position():
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
