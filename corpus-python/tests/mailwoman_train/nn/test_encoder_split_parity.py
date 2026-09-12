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

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python tests/mailwoman_train/test_encoder_split_parity.py
REFERENCE = Path(__file__).parent / "encoder-split-reference.json"

#: Written into the artifact so a reader meets it there rather than here.
REFERENCE_README = [
    "Pins the encoder's forward pass and its initial weights across a refactor.",
    "Regenerate: uv run python tests/mailwoman_train/test_encoder_split_parity.py",
    "Fixture: build_reference_encoder() in the test beside this file — every channel and head on.",
    "",
    "logits: one forward pass over 8 tokens with EVERY channel fed a seeded tensor, flattened.",
    "  Feeding no channel features is what let a reordered channel pass unnoticed once already.",
    "loss: the same call plus an all-O label row. forward computes the CRF, locale-aux,",
    "  span-boundary and conventions-mask terms on the way to it and returns none of them in",
    "  logits, so a split that drops one of those terms moves this and nothing else.",
    "state_dict_keys: what save_pretrained writes. A change invalidates existing checkpoints.",
    "parameter_checksums: each parameter's initial sum. Most are constants, not RNG state:",
    "  _init_weights zeroes biases and cue vectors, resets every LayerNorm gamma to 1.0 (a zeroed",
    "  gamma collapses the layer to a constant output, which it has done), and zeroes locale_film",
    "  last so locale conditioning starts as the identity. The remaining xavier_uniform_ weights",
    "  are the RNG-dependent ones: they move if module construction is REORDERED, which the logits",
    "  do not detect because the reference forward supplies no channel features.",
]

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
    """Every parameter's initial sum, as `_init_weights` leaves it.

    The logits alone do not cover this. The reference forward pass supplies no channel features,
    so a channel's projection is never invoked and never reaches a logit — a reordered channel
    passes a logit comparison while every weight after it has shifted. `_init_weights` draws in
    `self.parameters()` order, and these sums are what make that order observable.

    Most of these are constants rather than RNG state, and the artifact's README says which and
    why: `_init_weights` zeroes biases and cue vectors, resets every LayerNorm gamma to 1.0, and
    zeroes `locale_film` last so conditioning starts as a no-op. A constant moving means that
    policy changed; a drawn weight moving means construction order did.
    """
    return {name: round(float(p.detach().sum()), 6) for name, p in model.named_parameters()}


def reference_inputs(model: MailwomanCoarseEncoder) -> dict[str, torch.Tensor]:
    """A forward call that reaches EVERY channel, with seeded features.

    Passing no channel features is what let a reordered channel pass a logit comparison: a
    projection the forward never invokes cannot change a logit. Each channel gets a real tensor at
    its own declared width, so splitting `forward` into stages has to preserve what each one does
    with its input, not merely that it is skipped.
    """
    generator = torch.Generator().manual_seed(1)

    def noise(*shape: int) -> torch.Tensor:
        return torch.rand(*shape, generator=generator)

    input_ids = torch.arange(1, SEQ_LEN + 1, dtype=torch.long).unsqueeze(0)
    return {
        "input_ids": input_ids,
        "attention_mask": torch.ones_like(input_ids),
        "phrase_features": noise(1, SEQ_LEN, model.phrase_feature_dim),
        "locale_ids": torch.zeros(1, dtype=torch.long),
        "anchor_features": noise(1, SEQ_LEN, model.anchor_feature_dim),
        "anchor_confidence": noise(1, SEQ_LEN),
        "gazetteer_features": noise(1, SEQ_LEN, model.gazetteer_feature_dim),
        "gazetteer_confidence": noise(1, SEQ_LEN),
        "country_features": noise(1, SEQ_LEN, model.country_feature_dim),
        "country_confidence": noise(1, SEQ_LEN),
        "street_type_features": noise(1, SEQ_LEN, model.street_type_feature_dim),
        "street_type_confidence": noise(1, SEQ_LEN),
        "locality_surface_features": noise(1, SEQ_LEN, model.locality_surface_feature_dim),
        "locality_surface_confidence": noise(1, SEQ_LEN),
    }


def reference_logits(model: MailwomanCoarseEncoder) -> list[float]:
    with torch.no_grad():
        out = model(**reference_inputs(model))
    logits = out["logits"] if isinstance(out, dict) else out.logits
    return [round(v, 6) for v in logits.flatten().tolist()]


def reference_loss(model: MailwomanCoarseEncoder) -> float:
    """The supervised loss for a fixed label row, which the logits alone do not cover.

    `forward` computes the CRF term, the locale aux term, the span-boundary term and the conventions
    mask on the way to a loss, and returns none of them in `logits`. A split that drops one of those
    terms leaves the logits untouched.
    """
    inputs = reference_inputs(model)
    inputs["labels"] = torch.zeros(1, SEQ_LEN, dtype=torch.long)
    with torch.no_grad():
        out = model(**inputs)
    loss = out["loss"] if isinstance(out, dict) else out.loss
    return round(float(loss), 6)


def test_forward_is_deterministic_under_a_fixed_seed() -> None:
    """Sanity: the fixture is reproducible, so a later mismatch means the code moved."""
    first = reference_logits(build_reference_encoder())
    second = reference_logits(build_reference_encoder())
    assert first == second


#: How far a rebuilt value may sit from the committed one and still count as unmoved.
#:
#: NOT exact equality, which is what this compared first and why these two tests failed on CI while
#: passing on the machine that wrote the reference: the same fp32 graph over four transformer blocks
#: lands on a different last digit under a different CPU's kernels and vectorization (0.637875 here,
#: 0.637876 on the runner). Exact equality therefore pins the HOST as well as the code, and the
#: failure names the split rather than the machine.
#:
#: 1e-4 relative still does the job this pin exists for. A split that changes the forward pass —
#: a reordered channel, a dropped term, a head wired to the wrong input — moves a logit by a
#: fraction of its own magnitude, four orders of magnitude above this floor. Registration ORDER is
#: pinned exactly by `parameter_checksums`, which sums initial weights straight off the RNG and
#: never reaches a matmul, so the strict half of this file is unaffected.
TOLERANCE = 1e-4


def test_logits_match_the_committed_reference() -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())
    actual = reference_logits(build_reference_encoder())

    assert len(actual) == len(expected["logits"]), "logit count changed — the head geometry moved"
    assert actual == pytest.approx(expected["logits"], rel=TOLERANCE, abs=TOLERANCE), (
        "the split changed the forward pass"
    )


def test_loss_matches_the_committed_reference() -> None:
    """The loss terms `forward` computes and does not return."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())
    if "loss" not in expected:
        pytest.skip("reference predates the loss capture; regenerate it")

    assert reference_loss(build_reference_encoder()) == pytest.approx(expected["loss"], rel=TOLERANCE, abs=TOLERANCE), (
        "the split changed a loss term while leaving the logits intact"
    )


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


def test_every_layer_norm_gamma_starts_at_one() -> None:
    """The one init constant with a recorded failure behind it.

    `_init_weights` zeroes every 1-D parameter and then resets LayerNorm gamma to 1.0. Without
    that second pass a LayerNorm emits `0·normalized + beta` for every input, and the model
    predicts one class for every token — which it did, with loss flat at the all-O baseline.
    """
    for name, module in build_reference_encoder().named_modules():
        if isinstance(module, torch.nn.LayerNorm):
            assert torch.all(module.weight == 1.0), f"{name}.weight (gamma) is not 1.0"
            if module.bias is not None:
                assert torch.all(module.bias == 0.0), f"{name}.bias (beta) is not 0.0"


def test_parameter_initialization_matches_the_committed_reference() -> None:
    """Catches a construction reorder, which the logits do not.

    Swapping two soft-feed channels changes what `_init_weights` draws for each and for everything
    after them, so a from-scratch run stops reproducing earlier ones. Verified by swapping the
    street-type and locality-surface channels: the logit and key comparisons both stayed green,
    and these sums moved.
    """
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; regenerate it before splitting")
    expected = json.loads(REFERENCE.read_text())["parameter_checksums"]
    actual = parameter_checksums(build_reference_encoder())

    assert sorted(actual) == sorted(expected), "the parameter set changed"
    drifted = [name for name, total in actual.items() if total != expected[name]]
    assert drifted == [], f"initial weights moved for {len(drifted)} parameters, starting at {drifted[:3]}"


def write_reference() -> None:
    """Capture the current encoder as the reference the tests above compare against.

    Run this only when the current code already passes against the existing reference — otherwise
    the artifact records whatever the code does now, and the tests assert nothing.
    """
    model = build_reference_encoder()
    payload = {
        "README": REFERENCE_README,
        "logits": reference_logits(model),
        "loss": reference_loss(model),
        "state_dict_keys": sorted(model.state_dict().keys()),
        "parameter_checksums": parameter_checksums(model),
    }
    REFERENCE.write_text(json.dumps(payload, indent="\t", sort_keys=False) + "\n")
    print(f"wrote {REFERENCE}")
    print(f"  {len(payload['logits'])} logits, {len(payload['state_dict_keys'])} state-dict keys")
    print(f"  {len(payload['parameter_checksums'])} parameter checksums")


if __name__ == "__main__":
    write_reference()
