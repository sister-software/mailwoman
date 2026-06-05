"""Alignment tests for the gold-span anchor projection (#239/#240 de-risk pilot).

DeepSeek flagged a span→sub-token off-by-one as the silent run-killer, so this nails the one
property that matters: the anchor confidence/features land on EXACTLY the SP pieces the postcode
covers, and nowhere else — by reusing the same char→piece projection as the BIO labels. Uses mock
``PieceSpan``s (explicit char offsets) so no SentencePiece model is needed.
"""

from __future__ import annotations

import pytest

from mailwoman_train.labels import LOCALE_TO_ID, NUM_LOCALES
from mailwoman_train.tokenizer import (
    ANCHOR_FEATURE_DIM,
    PieceSpan,
    anchor_feature_vector,
    realign_anchor_to_pieces,
)

# "Strasse 12 10115 Berlin" — the postcode "10115" sits at chars [11, 16).
RAW = "Strasse 12 10115 Berlin"
TOKENS = ["Strasse", "12", "10115", "Berlin"]
LABELS = ["B-street", "B-house_number", "B-postcode", "B-locality"]
LOOKUP = {"10115": ({"DE": 1.0}, 52.53, 13.40)}


def _piece(text: str, begin: int, end: int) -> PieceSpan:
    return PieceSpan(piece=text, piece_id=0, char_begin=begin, char_end=end)


# Pieces: Strasse, _12, then the postcode split across two pieces (101 | 15), then Berlin.
PIECES = [
    _piece("Strasse", 0, 7),
    _piece("12", 8, 10),
    _piece("101", 11, 14),  # first half of the postcode
    _piece("15", 14, 16),  # second half of the postcode
    _piece("Berlin", 17, 23),
]


def test_anchor_lands_on_exactly_the_postcode_pieces():
    feats, confs = realign_anchor_to_pieces(RAW, TOKENS, LABELS, PIECES, LOOKUP)
    # Confidence 1.0 on the two postcode pieces (idx 2, 3), 0 everywhere else.
    assert confs == [0.0, 0.0, 1.0, 1.0, 0.0]
    # Both postcode pieces carry the SAME DE feature vector; non-postcode pieces are all-zero.
    de_vec = anchor_feature_vector({"DE": 1.0}, 52.53, 13.40)
    assert feats[2] == de_vec and feats[3] == de_vec
    assert feats[0] == [0.0] * ANCHOR_FEATURE_DIM
    assert feats[4] == [0.0] * ANCHOR_FEATURE_DIM


def test_unknown_postcode_yields_no_anchor():
    feats, confs = realign_anchor_to_pieces(RAW, TOKENS, LABELS, PIECES, {})  # empty lookup
    assert confs == [0.0] * len(PIECES)
    assert all(f == [0.0] * ANCHOR_FEATURE_DIM for f in feats)


def test_feature_vector_shape_and_content():
    vec = anchor_feature_vector({"DE": 1.0}, 52.53, 13.40)
    assert len(vec) == ANCHOR_FEATURE_DIM == NUM_LOCALES + 2
    assert vec[LOCALE_TO_ID["DE"]] == pytest.approx(1.0)
    assert vec[-2] == pytest.approx(52.53 / 90.0)  # normalized lat
    assert vec[-1] == pytest.approx(13.40 / 180.0)  # normalized lon
    assert sum(vec[:NUM_LOCALES]) == pytest.approx(1.0)  # posterior renormalized over the in-set mass


def test_collision_posterior_is_uniform_and_renormalized():
    # 75001 ∈ {FR, US} → uniform 0.5/0.5 over the two in-set locales.
    vec = anchor_feature_vector({"FR": 0.5, "US": 0.5}, 48.86, 2.33)
    assert vec[LOCALE_TO_ID["FR"]] == pytest.approx(0.5)
    assert vec[LOCALE_TO_ID["US"]] == pytest.approx(0.5)
    assert sum(vec[:NUM_LOCALES]) == pytest.approx(1.0)


def test_confidence_curriculum_no_op_early_perturbs_late():
    """The robustness curriculum is a no-op before 25% of max_steps, then perturbs downward + zeros
    whole rows after — never above 1.0, never a discrete regime (#239/#240)."""
    torch = pytest.importorskip("torch")
    from mailwoman_train.train import perturb_anchor_confidence

    conf = torch.ones(128, 6)
    assert torch.equal(perturb_anchor_confidence(conf, 0, 20000), conf)  # 0% → untouched
    assert torch.equal(perturb_anchor_confidence(conf, 4999, 20000), conf)  # <25% → untouched
    torch.manual_seed(0)
    late = perturb_anchor_confidence(conf, 15000, 20000)  # >50% → full perturbation
    assert not torch.equal(late, conf)
    assert float(late.max()) <= 1.0 and float(late.min()) >= 0.0
    zeroed_rows = int((late.sum(dim=1) == 0).sum().item())
    assert 0 < zeroed_rows < 128  # some rows fully zeroed (anchor "absent"), not all
