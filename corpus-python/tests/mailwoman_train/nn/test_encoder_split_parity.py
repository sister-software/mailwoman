"""Pins the encoder's logits, loss, state-dict keys and initial weights against a committed reference.

A refactor of `MailwomanCoarseEncoder` must keep all four. Existing checkpoints are keyed on attribute
names, so a renamed attribute loads as a missing key or as a fresh random tensor.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.labels import ACTIVE_BIO_LABELS  # noqa: E402
from mailwoman_train.nn.encoder import MailwomanCoarseEncoder  # noqa: E402

#: The committed reference. Regenerate it only after the current code passes against the existing file,
#: with `uv run python tests/mailwoman_train/nn/test_encoder_split_parity.py`.
REFERENCE = Path(__file__).parent / "encoder-split-reference.json"

#: This text is written into the reference file as its README.
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
    "  last. Therefore, locale conditioning starts as the identity. The remaining xavier_uniform_ weights",
    "  are the RNG-dependent ones: they move if module construction is REORDERED, which the logits",
    "  do not detect because the reference forward supplies no channel features.",
]

NUM_LABELS = len(ACTIVE_BIO_LABELS)
VOCAB_SIZE = 64
SEQ_LEN = 8


def build_reference_encoder() -> MailwomanCoarseEncoder:
    """Build a small seeded encoder with every optional channel and head enabled.

    Each channel draws from the RNG when it is constructed, so the initial weights record the
    construction order. A disabled channel would construct nothing, and a reordering involving it
    would go undetected.
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
    """Return the sum of each parameter after `_init_weights`, rounded to six places.

    `_init_weights` sets biases, cue vectors and `locale_film` to zero and LayerNorm gamma to 1.0, so
    those sums are constants. The remaining weights are drawn from the RNG in construction order, so
    their sums change when construction is reordered.
    """
    return {name: round(float(p.detach().sum()), 6) for name, p in model.named_parameters()}


def reference_inputs(model: MailwomanCoarseEncoder) -> dict[str, torch.Tensor]:
    """Return forward-call inputs that feed every channel a seeded tensor at its declared width.

    A channel without input never runs its projection, so its logits could not detect a change.
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
    """Return the flattened logits of the reference forward call, rounded to six places."""
    with torch.no_grad():
        out = model(**reference_inputs(model))
    logits = out["logits"] if isinstance(out, dict) else out.logits
    return [round(v, 6) for v in logits.flatten().tolist()]


def reference_loss(model: MailwomanCoarseEncoder) -> float:
    """Return the loss of the reference forward call with an all-``O`` label row.

    The CRF, locale auxiliary, span-boundary and conventions-mask terms affect only the loss, so a
    dropped term leaves the logits unchanged.
    """
    inputs = reference_inputs(model)
    inputs["labels"] = torch.zeros(1, SEQ_LEN, dtype=torch.long)
    with torch.no_grad():
        out = model(**inputs)
    loss = out["loss"] if isinstance(out, dict) else out.loss
    return round(float(loss), 6)


def test_forward_is_deterministic_under_a_fixed_seed() -> None:
    """Check that the fixture is reproducible, so a reference mismatch points at the code."""
    first = reference_logits(build_reference_encoder())
    second = reference_logits(build_reference_encoder())
    assert first == second


#: The relative and absolute tolerance for logits and loss. Different CPUs round the same fp32 graph
#: differently in the last digit, so exact equality would fail across hosts. The parameter checksums
#: involve no matrix multiplication and are still compared exactly.
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
    """Compare the reference loss, which covers terms that the logits omit."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text())
    if "loss" not in expected:
        pytest.skip("reference predates the loss capture; regenerate it")

    assert reference_loss(build_reference_encoder()) == pytest.approx(expected["loss"], rel=TOLERANCE, abs=TOLERANCE), (
        "the split changed a loss term while leaving the logits intact"
    )


def test_a_checkpoint_round_trips_through_save_and_load(tmp_path: Path) -> None:
    """Check that `save_pretrained` and `from_pretrained` preserve the weights and the config.

    A config flag that the writer emits and the reader ignores would rebuild a resumed run with the
    current default in place of its trained value.
    """
    original = build_reference_encoder()
    original.save_pretrained(tmp_path)

    written = json.loads((tmp_path / "config.json").read_text())
    reloaded = MailwomanCoarseEncoder.from_pretrained(tmp_path)

    assert sorted(reloaded.state_dict()) == sorted(original.state_dict())
    for key, before in original.state_dict().items():
        assert torch.equal(reloaded.state_dict()[key], before), f"{key} changed across the round trip"

    # A second save must write the same config, which shows that the reader kept every flag.
    reloaded.save_pretrained(tmp_path / "again")
    assert json.loads((tmp_path / "again" / "config.json").read_text()) == written

    # `from_pretrained` returns a model in train mode. In train mode `nn.MultiheadAttention` uses another
    # kernel whose results differ by about 1e-6 even at dropout 0.0, so the comparison runs in eval mode.
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
    """Check that every LayerNorm starts with gamma 1.0 and beta 0.0.

    `_init_weights` zeroes every 1-D parameter before it resets gamma. A zero gamma makes each
    LayerNorm output a constant, and the model then predicts one class for every token.
    """
    for name, module in build_reference_encoder().named_modules():
        if isinstance(module, torch.nn.LayerNorm):
            assert torch.all(module.weight == 1.0), f"{name}.weight (gamma) is not 1.0"
            if module.bias is not None:
                assert torch.all(module.bias == 0.0), f"{name}.bias (beta) is not 0.0"


def test_parameter_initialization_matches_the_committed_reference() -> None:
    """Compare initial parameter sums exactly to detect a change in construction order.

    Reordering two channels changes the weights drawn for them and for every module built after
    them, so a from-scratch run would no longer reproduce earlier runs.
    """
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; regenerate it before splitting")
    expected = json.loads(REFERENCE.read_text())["parameter_checksums"]
    actual = parameter_checksums(build_reference_encoder())

    assert sorted(actual) == sorted(expected), "the parameter set changed"
    drifted = [name for name, total in actual.items() if total != expected[name]]
    assert drifted == [], f"initial weights moved for {len(drifted)} parameters, starting at {drifted[:3]}"


def write_reference() -> None:
    """Write the current encoder's outputs to the reference file.

    Run this only when the current code already passes against the existing reference. Otherwise the
    tests would compare the code against itself.
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
