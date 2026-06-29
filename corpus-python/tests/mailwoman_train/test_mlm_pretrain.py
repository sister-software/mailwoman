"""MLM pre-training wiring smoke: masking + forward_mlm correctness.

The supervised trainer learns BIO classification from scratch; this checks the new
self-supervised PRE-training surface (masking.py + MailwomanCoarseEncoder.forward_mlm),
which produces an encoder checkpoint a later supervised run fine-tunes from. Runs in
seconds on CPU; NO real corpus, NO backward, NO optimizer — those are exercised by the
manual end-to-end smoke. Geometry + invariants only.

Covered:
- mask_tokens: ~mask_prob of ATTENDED tokens selected; pad positions NEVER masked; targets
  are the ORIGINAL ids at masked positions and -100 elsewhere; unselected inputs unchanged.
- forward_mlm: returns (B, S, vocab) logits + a finite scalar loss; uses the TIED token-
  embedding head so it adds NO parameters (state_dict key-identical to a supervised model);
  the supervised forward path still works unchanged.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.labels import ACTIVE_BIO_LABELS  # noqa: E402
from mailwoman_train.masking import mask_tokens  # noqa: E402
from mailwoman_train.model import MailwomanCoarseEncoder  # noqa: E402

NUM_LABELS = len(ACTIVE_BIO_LABELS)
VOCAB_SIZE = 64
PAD_ID = 0
UNK_ID = 1  # the mask substitute (SentencePiece has no [MASK])
HIDDEN_SIZE = 32


def _build_encoder() -> MailwomanCoarseEncoder:
    return MailwomanCoarseEncoder(
        vocab_size=VOCAB_SIZE,
        hidden_size=HIDDEN_SIZE,
        num_hidden_layers=2,
        num_attention_heads=2,
        intermediate_size=64,
        max_position_embeddings=32,
        hidden_dropout_prob=0.1,
        num_labels=NUM_LABELS,
        pad_token_id=PAD_ID,
        use_crf=False,
    )


def test_mask_tokens_respects_padding_and_targets() -> None:
    gen = torch.Generator().manual_seed(0)
    b, s = 32, 24
    ids = torch.randint(2, VOCAB_SIZE, (b, s))  # 2.. avoids pad(0)/unk(1)
    am = torch.ones(b, s, dtype=torch.long)
    am[:, 18:] = 0  # last 6 positions are padding

    masked, labels = mask_tokens(ids, am, mask_prob=0.15, mask_token_id=UNK_ID, vocab_size=VOCAB_SIZE, generator=gen)

    assert masked.shape == ids.shape
    assert labels.shape == ids.shape
    # pad positions are never selected for masking
    assert bool((labels[am == 0] == -100).all())
    selected = labels != -100
    # selection rate is roughly mask_prob over attended tokens
    rate = float(selected.sum()) / float(am.sum())
    assert 0.08 < rate < 0.22, rate
    # unselected inputs are unchanged; targets at selected positions equal the original id
    assert bool((masked[~selected] == ids[~selected]).all())
    assert bool((labels[selected] == ids[selected]).all())


def test_mask_tokens_deterministic_under_generator() -> None:
    ids = torch.randint(2, VOCAB_SIZE, (8, 16))
    am = torch.ones(8, 16, dtype=torch.long)
    a = mask_tokens(
        ids, am, mask_prob=0.15, mask_token_id=UNK_ID, vocab_size=VOCAB_SIZE, generator=torch.Generator().manual_seed(7)
    )
    b = mask_tokens(
        ids, am, mask_prob=0.15, mask_token_id=UNK_ID, vocab_size=VOCAB_SIZE, generator=torch.Generator().manual_seed(7)
    )
    assert bool((a[0] == b[0]).all()) and bool((a[1] == b[1]).all())


def test_forward_mlm_shapes_and_finite_loss() -> None:
    model = _build_encoder()
    ids = torch.randint(2, VOCAB_SIZE, (4, 12))
    am = torch.ones(4, 12, dtype=torch.long)
    am[:, 9:] = 0
    labels = ids.clone()
    labels[am == 0] = -100

    out = model.forward_mlm(input_ids=ids, attention_mask=am, mlm_labels=labels)
    assert out.logits.shape == (4, 12, VOCAB_SIZE)
    assert out.loss is not None
    assert out.loss.dim() == 0
    assert torch.isfinite(out.loss)
    # loss without labels is None (pure inference)
    assert model.forward_mlm(input_ids=ids, attention_mask=am).loss is None


def test_forward_mlm_adds_no_parameters_vs_supervised() -> None:
    """The tied-embedding MLM head reuses token_embeddings.weight — no new params, so the
    pretrain checkpoint's state_dict is key-identical to a supervised model's (loads via
    from_pretrained for fine-tuning)."""
    model = _build_encoder()
    keys_before = set(model.state_dict().keys())
    # touch forward_mlm; it must not have lazily created any module/parameter
    _ = model.forward_mlm(
        input_ids=torch.randint(2, VOCAB_SIZE, (2, 8)), attention_mask=torch.ones(2, 8, dtype=torch.long)
    )
    assert set(model.state_dict().keys()) == keys_before
    # supervised forward still works unchanged
    sup = model(
        input_ids=torch.randint(2, VOCAB_SIZE, (2, 8)),
        attention_mask=torch.ones(2, 8, dtype=torch.long),
        labels=torch.randint(0, NUM_LABELS, (2, 8)),
    )
    assert sup.logits.shape == (2, 8, NUM_LABELS)
    assert torch.isfinite(sup.loss)
