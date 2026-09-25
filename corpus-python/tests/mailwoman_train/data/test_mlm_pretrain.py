from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.data.masking import mask_tokens  # noqa: E402
from mailwoman_train.labels import ACTIVE_BIO_LABELS  # noqa: E402
from mailwoman_train.nn.encoder import MailwomanCoarseEncoder  # noqa: E402

NUM_LABELS = len(ACTIVE_BIO_LABELS)
VOCAB_SIZE = 64
PAD_ID = 0
UNK_ID = 1
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
    ids = torch.randint(2, VOCAB_SIZE, (b, s))
    am = torch.ones(b, s, dtype=torch.long)
    am[:, 18:] = 0

    masked, labels = mask_tokens(ids, am, mask_prob=0.15, mask_token_id=UNK_ID, vocab_size=VOCAB_SIZE, generator=gen)

    assert masked.shape == ids.shape
    assert labels.shape == ids.shape

    assert bool((labels[am == 0] == -100).all())
    selected = labels != -100

    rate = float(selected.sum()) / float(am.sum())
    assert 0.08 < rate < 0.22, rate

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

    assert model.forward_mlm(input_ids=ids, attention_mask=am).loss is None


def test_forward_mlm_adds_no_parameters_vs_supervised() -> None:
    model = _build_encoder()
    keys_before = set(model.state_dict().keys())

    _ = model.forward_mlm(
        input_ids=torch.randint(2, VOCAB_SIZE, (2, 8)), attention_mask=torch.ones(2, 8, dtype=torch.long)
    )
    assert set(model.state_dict().keys()) == keys_before

    sup = model(
        input_ids=torch.randint(2, VOCAB_SIZE, (2, 8)),
        attention_mask=torch.ones(2, 8, dtype=torch.long),
        labels=torch.randint(0, NUM_LABELS, (2, 8)),
    )
    assert sup.logits.shape == (2, 8, NUM_LABELS)
    assert torch.isfinite(sup.loss)
