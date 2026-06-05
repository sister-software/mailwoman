"""Tests for the postcode-anchor conditioning channel (#239/#240 de-risk pilot).

The load-bearing property is the NO-REGIME-SWITCH guarantee: a per-token confidence of 0 (an absent
postcode, or a confidence-zeroed anchor under the training curriculum) must make the injection an
EXACT identity. That is what lets "absent" be the continuous c=0 tail of a spectrum instead of a
discrete [NO-ANCHOR] mode (DeepSeek 2026-06-05) — and it is the reason no separate dropout token is
needed. Also covered: the channel actually does something at c>0, back-compat is bit-identical off,
the supplied-but-not-built guard fires, and the flags survive save/load.
"""

from __future__ import annotations

import pathlib
import tempfile

import pytest

torch = pytest.importorskip("torch")  # training deps (torch) aren't installed in lint-only envs

from mailwoman_train.labels import NUM_LOCALES  # noqa: E402
from mailwoman_train.model import MailwomanCoarseEncoder  # noqa: E402

ANCHOR_DIM = NUM_LOCALES + 2
_COMMON = dict(
    vocab_size=100,
    hidden_size=32,
    num_hidden_layers=2,
    num_attention_heads=4,
    intermediate_size=64,
    max_position_embeddings=16,
    hidden_dropout_prob=0.0,
    num_labels=9,
    pad_token_id=0,
    use_crf=False,
)


def _fixture():
    torch.manual_seed(0)
    m = MailwomanCoarseEncoder(**_COMMON, use_postcode_anchor=True).eval()
    ids = torch.randint(1, 100, (2, 8))
    mask = torch.ones(2, 8, dtype=torch.long)
    feats = torch.randn(2, 8, ANCHOR_DIM)
    return m, ids, mask, feats


def test_zero_confidence_is_exact_identity():
    """c=0 everywhere → logits identical to a no-anchor forward (the no-regime-switch property)."""
    m, ids, mask, feats = _fixture()
    with_zero = m(ids, attention_mask=mask, anchor_features=feats, anchor_confidence=torch.zeros(2, 8))
    no_anchor = m(ids, attention_mask=mask)
    assert torch.equal(with_zero.logits, no_anchor.logits)


def test_positive_confidence_changes_emissions():
    m, ids, mask, feats = _fixture()
    active = m(ids, attention_mask=mask, anchor_features=feats, anchor_confidence=torch.ones(2, 8))
    no_anchor = m(ids, attention_mask=mask)
    assert (active.logits - no_anchor.logits).abs().max() > 1e-3


def test_off_model_with_anchor_args_raises():
    off = MailwomanCoarseEncoder(**_COMMON, use_postcode_anchor=False).eval()
    ids = torch.randint(1, 100, (2, 8))
    mask = torch.ones(2, 8, dtype=torch.long)
    with pytest.raises(ValueError, match="use_postcode_anchor=False"):
        off(ids, attention_mask=mask, anchor_features=torch.randn(2, 8, ANCHOR_DIM),
            anchor_confidence=torch.zeros(2, 8))


def test_off_model_is_unchanged():
    """use_postcode_anchor=False builds no anchor params (back-compat / bit-identical)."""
    off = MailwomanCoarseEncoder(**_COMMON, use_postcode_anchor=False)
    assert off.anchor_projection is None and off.anchor_token_embedding is None
    assert not any("anchor" in n for n, _ in off.named_parameters())


def test_save_load_round_trips_the_channel():
    m, ids, mask, feats = _fixture()
    conf = torch.ones(2, 8)
    expected = m(ids, attention_mask=mask, anchor_features=feats, anchor_confidence=conf).logits
    with tempfile.TemporaryDirectory() as d:
        m.save_pretrained(d)
        reloaded = MailwomanCoarseEncoder.from_pretrained(pathlib.Path(d)).eval()
    assert reloaded.use_postcode_anchor and reloaded.anchor_feature_dim == ANCHOR_DIM
    got = reloaded(ids, attention_mask=mask, anchor_features=feats, anchor_confidence=conf).logits
    assert torch.allclose(got, expected, atol=1e-5)
