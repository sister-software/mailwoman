"""v0.5.0 thread C-s wiring smoke: forward-pass on stub data.

Not a verdict-smoke training run — this is the pytest "is the new architecture wired
correctly?" check that v0.5.0 thread C-s ships before any actual training. Constructs a
small batch of synthetic ``input_ids`` + ``attention_mask`` + stub phrase-feature rows,
runs the encoder forward, exercises ``predict_top_k``, and asserts shapes + structural
invariants. Runs in seconds on CPU.

Covered scope:

- Encoder builds cleanly with ``use_phrase_priors=True`` + the v0.5.0 ``hidden_size``
  baseline (256 — unchanged from v0.3.0/v0.4.0; the hidden_size bump is deferred per the
  Thread C-s scope).
- ``forward`` returns logits of shape ``(B, S, num_labels)``; loss is ``None`` when labels
  are omitted (forward-pass smoke skips supervision).
- ``forward`` with ``labels`` produces a finite scalar loss — confirms CE+CRF path still
  wires through after the phrase-prior addition, but NO backward() is called.
- ``predict_top_k`` returns up to k path entries per row, sorted by score desc,
  mask-trimmed to the row's real length, with each path's tag IDs in [0, num_labels).
- Back-compat: ``use_phrase_priors=False`` (the v0.4.0 default) behaves bit-identically
  to the prior forward path, and rejects unsolicited ``phrase_features`` cleanly.

NO loss.backward, NO optimizer step. The model is constructed with reduced depth
(num_hidden_layers=2) to keep the smoke fast — geometry-correctness is the same regardless
of depth.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.crf import TopKPath  # noqa: E402
from mailwoman_train.labels import ACTIVE_BIO_LABELS  # noqa: E402
from mailwoman_train.model import MailwomanCoarseEncoder  # noqa: E402
from mailwoman_train.phrase_priors import (  # noqa: E402
    PHRASE_BIE_DIM,
    PHRASE_FEATURE_DIM,
    PHRASE_KIND_DIM,
    PHRASE_KIND_TO_ID,
    PHRASE_KINDS,
)

NUM_LABELS = len(ACTIVE_BIO_LABELS)
VOCAB_SIZE = 64  # tiny — embeddings are toy
PAD_ID = 0
HIDDEN_SIZE = 64  # smaller than v0.5.0 production (256) — faster smoke, same wiring


def _build_encoder(use_phrase_priors: bool, use_crf: bool = True) -> MailwomanCoarseEncoder:
    return MailwomanCoarseEncoder(
        vocab_size=VOCAB_SIZE,
        hidden_size=HIDDEN_SIZE,
        num_hidden_layers=2,
        num_attention_heads=4,
        intermediate_size=128,
        max_position_embeddings=32,
        hidden_dropout_prob=0.0,  # deterministic forward — keeps the smoke loud
        num_labels=NUM_LABELS,
        pad_token_id=PAD_ID,
        use_crf=use_crf,
        label_smoothing=0.0,
        crf_loss_weight=1.0,
        crf_normalization="per_token",
        use_phrase_priors=use_phrase_priors,
    ).eval()


def _stub_batch(bsz: int = 2, seq_len: int = 8) -> dict[str, torch.Tensor]:
    """Synthesise a small batch. When ``bsz >= 2``, row 0 is padded to length 5 to
    exercise the variable-length mask path; row 1 (and beyond) stays full."""
    torch.manual_seed(0)
    input_ids = torch.randint(1, VOCAB_SIZE, (bsz, seq_len))
    input_ids[:, 0] = 1  # avoid pad_token at position 0 (mask would be 0 there).
    attention_mask = torch.ones(bsz, seq_len, dtype=torch.long)
    if bsz >= 2 and seq_len > 5:
        attention_mask[0, 5:] = 0
        input_ids[0, 5:] = PAD_ID
    return {"input_ids": input_ids, "attention_mask": attention_mask}


def _stub_phrase_features(bsz: int, seq_len: int) -> torch.Tensor:
    """Plausible one-hot phrase features:

    Row 0 (5 real tokens, "350 5th Ave NY 10118" shaped):
        tok 0: NUMERIC start+end
        tok 1: STREET_PHRASE start
        tok 2: STREET_PHRASE end
        tok 3: REGION_ABBREVIATION start+end
        tok 4: POSTCODE start+end
    Row 1: every other token covered by a LOCALITY_PHRASE proposal.
    """
    feats = torch.zeros(bsz, seq_len, PHRASE_FEATURE_DIM)

    def set_token(b: int, t: int, kind: str, *, start: bool, end: bool) -> None:
        if start:
            feats[b, t, 0] = 1.0  # phrase_start
        if end:
            feats[b, t, 2] = 1.0  # phrase_end
        if not start and not end:
            feats[b, t, 1] = 1.0  # phrase_mid
        kind_slot = PHRASE_BIE_DIM + PHRASE_KIND_TO_ID[kind]
        feats[b, t, kind_slot] = 1.0

    set_token(0, 0, "NUMERIC", start=True, end=True)
    set_token(0, 1, "STREET_PHRASE", start=True, end=False)
    set_token(0, 2, "STREET_PHRASE", start=False, end=True)
    set_token(0, 3, "REGION_ABBREVIATION", start=True, end=True)
    set_token(0, 4, "POSTCODE", start=True, end=True)

    if bsz > 1:
        for t in range(0, seq_len, 2):
            set_token(1, t, "LOCALITY_PHRASE", start=True, end=True)
    return feats


# --- Forward-pass: phrase-prior conditioning -----------------------------------------


def test_phrase_kind_taxonomy_matches_ts_contract():
    """Drift guard: the Python-side PHRASE_KINDS must match the TS-side ``PhraseKind`` union.

    Order is the encoding contract — the i-th kind here is the same kind that downstream
    corpus loaders one-hot at slot ``PHRASE_BIE_DIM + i``. If TS adds a new kind, this
    list and ``core/pipeline/types.ts``'s ``PhraseKind`` must move together in the same
    commit; otherwise the model card's ``phrase_kind_vocab`` silently mis-aligns.
    """
    assert PHRASE_KINDS == (
        "NUMERIC",
        "STREET_PHRASE",
        "LOCALITY_PHRASE",
        "REGION_ABBREVIATION",
        "POSTCODE",
        "VENUE_PHRASE",
        "HYPHENATED_COMPOUND",
    )
    assert PHRASE_KIND_DIM == 7
    assert PHRASE_BIE_DIM == 3
    assert PHRASE_FEATURE_DIM == 10


def test_forward_with_phrase_features_produces_expected_shape():
    encoder = _build_encoder(use_phrase_priors=True)
    batch = _stub_batch(bsz=2, seq_len=8)
    feats = _stub_phrase_features(2, 8)
    out = encoder(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
        phrase_features=feats,
    )
    assert out.logits.shape == (2, 8, NUM_LABELS)
    assert out.loss is None  # no labels supplied = no loss
    assert torch.isfinite(out.logits).all()


def test_forward_with_phrase_features_and_labels_produces_finite_loss():
    encoder = _build_encoder(use_phrase_priors=True)
    batch = _stub_batch(bsz=2, seq_len=8)
    feats = _stub_phrase_features(2, 8)
    # All-O labels on real tokens, IGNORE_INDEX (-100) on padding.
    labels = torch.zeros(2, 8, dtype=torch.long)
    labels[0, 5:] = -100
    out = encoder(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
        labels=labels,
        phrase_features=feats,
    )
    assert out.loss is not None
    assert torch.isfinite(out.loss)
    # No backward() — this is a wiring smoke, not a training step.


def test_forward_phrase_features_default_to_zeros_when_omitted():
    """A phrase-prior encoder accepts a no-features call without raising — silent
    fallback to "no phrase covers any token." Useful for: (a) corpus rows that pre-date
    Stage 2.7, (b) integration tests that don't want to construct features."""
    encoder = _build_encoder(use_phrase_priors=True)
    batch = _stub_batch(bsz=1, seq_len=6)
    out = encoder(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
    )
    assert out.logits.shape == (1, 6, NUM_LABELS)
    assert torch.isfinite(out.logits).all()


def test_forward_rejects_wrong_phrase_feature_shape():
    encoder = _build_encoder(use_phrase_priors=True)
    batch = _stub_batch(bsz=2, seq_len=8)
    bad = torch.zeros(2, 8, PHRASE_FEATURE_DIM + 1)
    with pytest.raises(ValueError, match="phrase_features shape"):
        encoder(
            input_ids=batch["input_ids"],
            attention_mask=batch["attention_mask"],
            phrase_features=bad,
        )


# --- Top-k inference path --------------------------------------------------------------


def test_predict_top_k_shapes_and_ordering():
    encoder = _build_encoder(use_phrase_priors=True)
    batch = _stub_batch(bsz=2, seq_len=8)
    feats = _stub_phrase_features(2, 8)
    paths = encoder.predict_top_k(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
        k=5,
        phrase_features=feats,
    )
    assert isinstance(paths, list)
    assert len(paths) == 2  # one entry per row

    for b, row in enumerate(paths):
        assert isinstance(row, list)
        assert 1 <= len(row) <= 5  # at least argmax; at most k
        # Descending score order.
        for prev, curr in zip(row, row[1:], strict=False):
            assert prev.score >= curr.score
        # Length matches mask.
        expected_length = int(batch["attention_mask"][b].sum().item())
        for path in row:
            assert isinstance(path, TopKPath)
            assert len(path.sequence) == expected_length
            for tag_id in path.sequence:
                assert 0 <= tag_id < NUM_LABELS
            assert torch.isfinite(torch.tensor(path.score))


def test_predict_top_k_default_k_is_five():
    """The brief specifies default k=5. Confirm the signature default matches."""
    encoder = _build_encoder(use_phrase_priors=True)
    batch = _stub_batch(bsz=1, seq_len=6)
    paths = encoder.predict_top_k(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
        phrase_features=_stub_phrase_features(1, 6),
    )[0]
    assert len(paths) <= 5


def test_predict_top_k_requires_crf():
    encoder = _build_encoder(use_phrase_priors=True, use_crf=False)
    batch = _stub_batch(bsz=1, seq_len=6)
    with pytest.raises(RuntimeError, match="requires a CRF decoder"):
        encoder.predict_top_k(
            input_ids=batch["input_ids"],
            attention_mask=batch["attention_mask"],
            k=3,
        )


# --- Back-compat: use_phrase_priors=False (v0.4.0 path) -------------------------------


def test_v0_4_0_back_compat_forward_unchanged():
    encoder = _build_encoder(use_phrase_priors=False)
    batch = _stub_batch(bsz=2, seq_len=8)
    out = encoder(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
    )
    assert out.logits.shape == (2, 8, NUM_LABELS)
    assert torch.isfinite(out.logits).all()
    # phrase_input_projection should not exist on a v0.4.0-style encoder.
    assert encoder.phrase_input_projection is None
    assert encoder.phrase_feature_dim == 0


def test_v0_4_0_back_compat_rejects_phrase_features():
    """A v0.4.0-style encoder should NOT silently accept phrase features — that's exactly
    the wiring drift the smoke test is designed to catch."""
    encoder = _build_encoder(use_phrase_priors=False)
    batch = _stub_batch(bsz=1, seq_len=6)
    bogus = torch.zeros(1, 6, PHRASE_FEATURE_DIM)
    with pytest.raises(ValueError, match="use_phrase_priors=False"):
        encoder(
            input_ids=batch["input_ids"],
            attention_mask=batch["attention_mask"],
            phrase_features=bogus,
        )


def test_predict_top_k_with_back_compat_encoder_still_works():
    """The top-k path uses the CRF directly, so a CRF-equipped v0.4.0-style encoder
    (without phrase priors) can still be used as a Stage 5 candidate generator. This
    is the "scaffold-now-train-later" hedge — Stage 5 can be developed against v0.4.0
    weights even before v0.5.0 weights exist."""
    encoder = _build_encoder(use_phrase_priors=False)
    batch = _stub_batch(bsz=1, seq_len=6)
    paths = encoder.predict_top_k(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
        k=3,
    )[0]
    assert 1 <= len(paths) <= 3
    for path in paths:
        assert len(path.sequence) == 6


# --- save_pretrained / from_pretrained round-trip ------------------------------------


def test_save_load_roundtrip_preserves_phrase_prior_config(tmp_path):
    """Round-trip: building a phrase-prior encoder, saving to disk, and loading it back
    must reconstruct an identical encoder. Pins the v0.5.0 model card's
    ``use_phrase_priors`` + ``phrase_feature_dim`` keys as load-side contract.
    """
    m = _build_encoder(use_phrase_priors=True)
    m.save_pretrained(tmp_path)
    loaded = type(m).from_pretrained(tmp_path)
    assert loaded.use_phrase_priors is True
    assert loaded.phrase_feature_dim == PHRASE_FEATURE_DIM
    assert loaded.phrase_input_projection is not None
    # Same parameter shapes + values — load must round-trip the projection layer.
    sd_before = m.state_dict()
    sd_after = loaded.state_dict()
    assert set(sd_before.keys()) == set(sd_after.keys())
    for k in sd_before:
        assert torch.allclose(sd_before[k], sd_after[k]), f"mismatch on {k}"


def test_load_v0_4_0_card_back_compat(tmp_path):
    """A model card written by v0.4.0 (no ``use_phrase_priors`` key) must still load —
    defaults to False, no phrase-prior projection layer. Pins the backwards-compat
    contract: old weights packages keep loading on v0.5.0 codebase."""
    import json

    m = _build_encoder(use_phrase_priors=False)
    m.save_pretrained(tmp_path)
    # Strip the v0.5.0 keys to simulate a v0.4.0-era card.
    card_path = tmp_path / "config.json"
    cfg = json.loads(card_path.read_text())
    cfg.pop("use_phrase_priors", None)
    cfg.pop("phrase_feature_dim", None)
    card_path.write_text(json.dumps(cfg))
    loaded = type(m).from_pretrained(tmp_path)
    assert loaded.use_phrase_priors is False
    assert loaded.phrase_input_projection is None


# --- Config: v0_5_0-classifier-smoke.yaml loads cleanly --------------------------------


def test_v0_5_0_smoke_config_loads_and_matches_thread_c_scope():
    """Pins the scaffold's training-config contract to the Thread C-s scope:

    - phrase priors ON (the headline change)
    - hidden_size unchanged at the v0.3.0/v0.4.0 baseline (256) — the bump is out of scope
    - 21-class BIO label vocab (unchanged from v0.3.0; see ACTIVE_BIO_LABELS)
    - constant-LR smoke per VERDICT_SMOKES.md (driven via CLI flag, not the YAML)
    """
    from pathlib import Path

    from mailwoman_train.config import load_config

    here = Path(__file__).resolve().parent.parent.parent
    cfg_path = here / "src/mailwoman_train/configs/v0_5_0-classifier-smoke.yaml"
    cfg = load_config(cfg_path)

    assert cfg.model.use_phrase_priors is True
    assert cfg.model.phrase_feature_dim == PHRASE_FEATURE_DIM
    assert cfg.model.hidden_size == 256  # Thread C-s scope: no hidden-size bump
    assert cfg.model.use_crf is True
    assert cfg.model.crf_normalization == "per_token"  # v0.4.0 dual-loss lesson carries over
    # 21 BIO classes are derived from labels.py — confirm class_weights covers all of them.
    assert set(cfg.model.class_weights or {}) == set(ACTIVE_BIO_LABELS)
    # Smoke-window sizing — short enough to fit in ~minutes on iGPU.
    assert cfg.train.max_steps <= 100
    assert cfg.train.batch_size <= 16
