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
    """A small encoder with EVERY optional channel and head on, built from a fixed seed.

    Every flag is on deliberately. Each channel's `nn.Linear` draws from the RNG as it is
    constructed, so the initial weights encode the construction ORDER — reordering two channels,
    or building one that the old code skipped, changes every weight downstream of the change. A
    channel left off in the fixture constructs nothing and cannot catch a reordering that involves
    it, which is why none are left off.
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
        inject_first_token=True,
        use_gazetteer_anchor=True,
        use_country_anchor=True,
        country_ambiguous_scale=0.5,
        use_street_type_anchor=True,
        use_locality_surface_anchor=True,
        use_affix_head=True,
        use_deploc_head=True,
        use_conventions_loss_mask=True,
        use_span_boundary_head=True,
        span_boundary_loss_weight=0.1,
        use_span_scorer=True,
        span_loss_weight=0.1,
    ).eval()


def parameter_checksums(model: MailwomanCoarseEncoder) -> dict[str, float]:
    """A per-parameter sum, which changes if that parameter's initial values change.

    The logits alone do not cover this. The reference forward pass supplies no channel features,
    so a channel's projection is never invoked and never reaches a logit — a reordered channel
    passes a logit comparison while every weight after it has shifted. `_init_weights` draws in
    `self.parameters()` order, and these sums are what make that order observable.
    """
    return {name: round(float(p.detach().sum()), 6) for name, p in model.named_parameters()}


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


def test_parameter_initialization_matches_the_committed_reference() -> None:
    """Catches a construction reorder, which the logits do not.

    Swapping two soft-feed channels changes what `_init_weights` draws for each and for everything
    after them, so a from-scratch run stops reproducing earlier ones. Verified by swapping the
    street-type and locality-surface channels: the logit and key comparisons both stayed green,
    and these sums moved.
    """
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())
    actual = parameter_checksums(build_reference_encoder())

    assert sorted(actual) == sorted(expected["parameter_checksums"]), "the parameter set changed"
    drifted = [name for name, total in actual.items() if total != expected["parameter_checksums"][name]]
    assert drifted == [], f"initial weights moved for {len(drifted)} parameters, starting at {drifted[:3]}"
