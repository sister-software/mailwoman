from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.features.phrase_priors import (  # noqa: E402
    PHRASE_BIE_DIM,
    PHRASE_FEATURE_DIM,
    PHRASE_KIND_DIM,
    PHRASE_KIND_TO_ID,
    PHRASE_KINDS,
)
from mailwoman_train.labels import ACTIVE_BIO_LABELS  # noqa: E402
from mailwoman_train.nn.crf import TopKPath  # noqa: E402
from mailwoman_train.nn.encoder import MailwomanCoarseEncoder  # noqa: E402

NUM_LABELS = len(ACTIVE_BIO_LABELS)
VOCAB_SIZE = 64
PAD_ID = 0
HIDDEN_SIZE = 64


def _build_encoder(use_phrase_priors: bool, use_crf: bool = True) -> MailwomanCoarseEncoder:
    return MailwomanCoarseEncoder(
        vocab_size=VOCAB_SIZE,
        hidden_size=HIDDEN_SIZE,
        num_hidden_layers=2,
        num_attention_heads=4,
        intermediate_size=128,
        max_position_embeddings=32,
        hidden_dropout_prob=0.0,
        num_labels=NUM_LABELS,
        pad_token_id=PAD_ID,
        use_crf=use_crf,
        label_smoothing=0.0,
        crf_loss_weight=1.0,
        crf_normalization="per_token",
        use_phrase_priors=use_phrase_priors,
    ).eval()


def _stub_batch(bsz: int = 2, seq_len: int = 8) -> dict[str, torch.Tensor]:
    torch.manual_seed(0)
    input_ids = torch.randint(1, VOCAB_SIZE, (bsz, seq_len))
    input_ids[:, 0] = 1
    attention_mask = torch.ones(bsz, seq_len, dtype=torch.long)
    if bsz >= 2 and seq_len > 5:
        attention_mask[0, 5:] = 0
        input_ids[0, 5:] = PAD_ID
    return {"input_ids": input_ids, "attention_mask": attention_mask}


def _stub_phrase_features(bsz: int, seq_len: int) -> torch.Tensor:
    feats = torch.zeros(bsz, seq_len, PHRASE_FEATURE_DIM)

    def set_token(b: int, t: int, kind: str, *, start: bool, end: bool) -> None:
        if start:
            feats[b, t, 0] = 1.0
        if end:
            feats[b, t, 2] = 1.0
        if not start and not end:
            feats[b, t, 1] = 1.0
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


def test_phrase_kind_taxonomy_matches_ts_interface():
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
    assert out.loss is None
    assert torch.isfinite(out.logits).all()


def test_forward_with_phrase_features_and_labels_produces_finite_loss():
    encoder = _build_encoder(use_phrase_priors=True)
    batch = _stub_batch(bsz=2, seq_len=8)
    feats = _stub_phrase_features(2, 8)

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


def test_forward_phrase_features_default_to_zeros_when_omitted():
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
    assert len(paths) == 2

    for b, row in enumerate(paths):
        assert isinstance(row, list)
        assert 1 <= len(row) <= 5

        for prev, curr in zip(row, row[1:], strict=False):
            assert prev.score >= curr.score

        expected_length = int(batch["attention_mask"][b].sum().item())
        for path in row:
            assert isinstance(path, TopKPath)
            assert len(path.sequence) == expected_length
            for tag_id in path.sequence:
                assert 0 <= tag_id < NUM_LABELS
            assert torch.isfinite(torch.tensor(path.score))


def test_predict_top_k_default_k_is_five():
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


def test_v0_4_0_back_compat_forward_unchanged():
    encoder = _build_encoder(use_phrase_priors=False)
    batch = _stub_batch(bsz=2, seq_len=8)
    out = encoder(
        input_ids=batch["input_ids"],
        attention_mask=batch["attention_mask"],
    )
    assert out.logits.shape == (2, 8, NUM_LABELS)
    assert torch.isfinite(out.logits).all()

    assert encoder.phrase_input_projection is None
    assert encoder.phrase_feature_dim == 0


def test_v0_4_0_back_compat_rejects_phrase_features():
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


def test_save_load_roundtrip_preserves_phrase_prior_config(tmp_path):
    m = _build_encoder(use_phrase_priors=True)
    m.save_pretrained(tmp_path)
    loaded = type(m).from_pretrained(tmp_path)
    assert loaded.use_phrase_priors is True
    assert loaded.phrase_feature_dim == PHRASE_FEATURE_DIM
    assert loaded.phrase_input_projection is not None

    sd_before = m.state_dict()
    sd_after = loaded.state_dict()
    assert set(sd_before.keys()) == set(sd_after.keys())
    for k in sd_before:
        assert torch.allclose(sd_before[k], sd_after[k]), f"mismatch on {k}"


def test_load_v0_4_0_card_back_compat(tmp_path):
    import json

    m = _build_encoder(use_phrase_priors=False)
    m.save_pretrained(tmp_path)

    card_path = tmp_path / "config.json"
    cfg = json.loads(card_path.read_text())
    cfg.pop("use_phrase_priors", None)
    cfg.pop("phrase_feature_dim", None)
    card_path.write_text(json.dumps(cfg))
    loaded = type(m).from_pretrained(tmp_path)
    assert loaded.use_phrase_priors is False
    assert loaded.phrase_input_projection is None


def test_v0_5_0_smoke_config_loads_and_matches_thread_c_scope():

    from mailwoman_train.config import load_config
    from mailwoman_train.labels import STAGE2_BIO_LABELS
    from tests import paths

    cfg_path = paths.CONFIGS / "v0_5_0-classifier-smoke.yaml"
    cfg = load_config(cfg_path)

    assert cfg.model.use_phrase_priors is True
    assert cfg.model.phrase_feature_dim == PHRASE_FEATURE_DIM
    assert cfg.model.hidden_size == 256
    assert cfg.model.use_crf is True
    assert cfg.model.crf_normalization == "per_token"

    weights = set(cfg.model.class_weights or {})
    assert weights == set(STAGE2_BIO_LABELS)
    assert weights <= set(ACTIVE_BIO_LABELS)

    assert cfg.train.max_steps <= 100
    assert cfg.train.batch_size <= 16
