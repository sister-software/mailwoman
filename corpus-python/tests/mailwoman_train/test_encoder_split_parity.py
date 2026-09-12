"""The encoder split must not move a single logit, or rename a single state-dict key.

`__init__` is 405 lines and `forward` 415. Breaking either into named stages is where an
initialization order or a branch condition changes without any test noticing: the suite exercises
shapes and finiteness, not values. So this pins values.

The state-dict keys matter as much as the logits. `save_pretrained` writes a checkpoint keyed on
attribute names, and every checkpoint on the Modal volume was written by the pre-split code. An
attribute renamed during the split loads as a missing key, or silently as a fresh random tensor.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.labels import ACTIVE_BIO_LABELS  # noqa: E402
from mailwoman_train.nn.encoder import MailwomanCoarseEncoder  # noqa: E402

#: Committed beside this file by the pre-split code; regenerating it after the split would make the
#: test compare the new code against itself.
REFERENCE = Path(__file__).parent / "encoder-split-reference.json"

NUM_LABELS = len(ACTIVE_BIO_LABELS)
VOCAB_SIZE = 64
SEQ_LEN = 8


def build_reference_encoder() -> MailwomanCoarseEncoder:
    """A small encoder with every optional head on, built from a fixed seed.

    The channels are on deliberately: a split that reorders parameter construction shows up as
    different initial weights, and a channel left out of the fixture cannot catch that.
    """
    torch.manual_seed(0)
    return MailwomanCoarseEncoder(
        vocab_size=VOCAB_SIZE,
        hidden_size=32,
        num_hidden_layers=2,
        num_attention_heads=2,
        intermediate_size=64,
        max_position_embeddings=32,
        hidden_dropout_prob=0.0,
        num_labels=NUM_LABELS,
        pad_token_id=0,
        use_crf=True,
        label_smoothing=0.0,
        crf_loss_weight=1.0,
        use_phrase_priors=True,
        use_locale_conditioning=True,
        use_postcode_anchor=True,
    ).eval()


def reference_logits(model: MailwomanCoarseEncoder) -> list[float]:
    input_ids = torch.arange(1, SEQ_LEN + 1, dtype=torch.long).unsqueeze(0)
    attention_mask = torch.ones_like(input_ids)
    with torch.no_grad():
        out = model(input_ids=input_ids, attention_mask=attention_mask)
    logits = out["logits"] if isinstance(out, dict) else out.logits
    return [round(v, 6) for v in logits.flatten().tolist()]


def test_forward_is_deterministic_under_a_fixed_seed() -> None:
    """Sanity: the fixture is reproducible, so a later mismatch means the code moved."""
    first = reference_logits(build_reference_encoder())
    second = reference_logits(build_reference_encoder())
    assert first == second


def test_logits_match_the_committed_reference() -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())
    actual = reference_logits(build_reference_encoder())

    assert len(actual) == len(expected["logits"]), "logit count changed — the head geometry moved"
    assert actual == expected["logits"], "the split changed the forward pass"


def test_a_checkpoint_round_trips_through_save_and_load(tmp_path: Path) -> None:
    """save_pretrained then from_pretrained must return the same weights and the same config.

    The serialization halves moved out of the encoder together. A flag written by one and not read
    by the other rebuilds a resumed run with today's default instead of the value it trained under,
    and nothing about that failure is visible in a shape or a loss.
    """
    original = build_reference_encoder()
    original.save_pretrained(tmp_path)

    written = json.loads((tmp_path / "config.json").read_text())
    reloaded = MailwomanCoarseEncoder.from_pretrained(tmp_path)

    assert sorted(reloaded.state_dict()) == sorted(original.state_dict())
    for key, before in original.state_dict().items():
        assert torch.equal(reloaded.state_dict()[key], before), f"{key} changed across the round trip"

    # Every flag the writer emits must survive a rebuild, or the reader is ignoring it.
    reloaded.save_pretrained(tmp_path / "again")
    assert json.loads((tmp_path / "again" / "config.json").read_text()) == written

    # `from_pretrained` returns a model in TRAIN mode, which is what a resume wants. Compare in
    # eval: `nn.MultiheadAttention` takes a different kernel path while training, so the reduction
    # order differs by ~1e-6 even at dropout 0.0. In eval the two are bitwise equal.
    reloaded.eval()
    assert reference_logits(reloaded) == reference_logits(original)


def test_state_dict_keys_match_the_committed_reference() -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())
    actual = sorted(build_reference_encoder().state_dict().keys())

    assert actual == expected["state_dict_keys"], (
        "a state-dict key changed; every checkpoint on the volume was written with the old names"
    )
