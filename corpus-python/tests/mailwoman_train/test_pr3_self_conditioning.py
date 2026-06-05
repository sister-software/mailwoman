"""PR3 self-conditioning wiring smoke (CPU, seconds).

The "is the new architecture wired correctly?" check that PR3 ships BEFORE any GPU run. Builds a
tiny encoder with ``use_locale_conditioning=True``, runs forward, and asserts the locale head +
FiLM modulation + auxiliary loss are wired and finite. Also covers the cross-pollution tripwire
metric, save/load round-trip, back-compat with the conditioning OFF, and that the pilot config
loads with the expected scope.

NO loss.backward, NO optimizer step, NO GPU. Geometry + numerical-sanity only — the falsify-before-
you-spend gate for the self-conditioned retrain.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.labels import (  # noqa: E402
    ACTIVE_BIO_LABELS,
    IGNORE_INDEX,
    LABEL_TO_ID,
    LOCALE_TO_ID,
    NUM_LOCALES,
    locale_id,
)
from mailwoman_train.model import MailwomanCoarseEncoder  # noqa: E402
from mailwoman_train.train import _cross_pollution  # noqa: E402

NUM_LABELS = len(ACTIVE_BIO_LABELS)
VOCAB_SIZE = 64
PAD_ID = 0
HIDDEN_SIZE = 64


def _build_encoder(
    use_locale_conditioning: bool,
    locale_loss_weight: float = 0.3,
    use_crf: bool = True,
) -> MailwomanCoarseEncoder:
    return MailwomanCoarseEncoder(
        vocab_size=VOCAB_SIZE,
        hidden_size=HIDDEN_SIZE,
        num_hidden_layers=2,
        num_attention_heads=4,
        intermediate_size=128,
        max_position_embeddings=32,
        hidden_dropout_prob=0.0,  # deterministic forward
        num_labels=NUM_LABELS,
        pad_token_id=PAD_ID,
        use_crf=use_crf,
        label_smoothing=0.0,
        crf_loss_weight=0.0,  # CRF off like the pilot
        use_locale_conditioning=use_locale_conditioning,
        locale_loss_weight=locale_loss_weight,
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


# --- labels: locale id map ------------------------------------------------------------


def test_locale_id_map():
    assert locale_id("US") == LOCALE_TO_ID["US"]
    assert locale_id("de") == LOCALE_TO_ID["DE"]  # case-insensitive
    assert locale_id("ZZ") == IGNORE_INDEX  # unmapped country
    assert locale_id(None) == IGNORE_INDEX
    assert NUM_LOCALES == len(LOCALE_TO_ID)
    # Append-only contract: US/FR/DE are the pilot's first three ids.
    assert LOCALE_TO_ID["US"] == 0 and LOCALE_TO_ID["FR"] == 1 and LOCALE_TO_ID["DE"] == 2


# --- forward: shapes + finiteness -----------------------------------------------------


def test_forward_emits_locale_logits_and_bio_logits():
    enc = _build_encoder(use_locale_conditioning=True)
    b = _stub_batch(2, 8)
    out = enc(input_ids=b["input_ids"], attention_mask=b["attention_mask"])
    assert out.logits.shape == (2, 8, NUM_LABELS)
    assert out.locale_logits is not None
    assert out.locale_logits.shape == (2, NUM_LOCALES)
    assert torch.isfinite(out.logits).all()
    assert torch.isfinite(out.locale_logits).all()
    assert out.loss is None  # no labels


def test_film_is_identity_at_init():
    """The FiLM projection is zero-initialized, so conditioning starts as an exact no-op — the
    model begins identical to an unconditioned encoder and learns to modulate gradually. This is
    the de-risking move against a cold-start architecture shock."""
    enc = _build_encoder(use_locale_conditioning=True)
    assert enc.locale_film is not None
    assert int(torch.count_nonzero(enc.locale_film.weight)) == 0
    assert int(torch.count_nonzero(enc.locale_film.bias)) == 0


def test_aux_locale_loss_is_finite():
    enc = _build_encoder(use_locale_conditioning=True, locale_loss_weight=0.3)
    b = _stub_batch(2, 8)
    labels = torch.zeros(2, 8, dtype=torch.long)
    labels[0, 5:] = IGNORE_INDEX
    locale_ids = torch.tensor([LOCALE_TO_ID["US"], LOCALE_TO_ID["DE"]], dtype=torch.long)
    out = enc(
        input_ids=b["input_ids"],
        attention_mask=b["attention_mask"],
        labels=labels,
        locale_ids=locale_ids,
    )
    assert out.loss is not None
    assert torch.isfinite(out.loss)


def test_all_ignored_locale_batch_does_not_nan():
    """A batch whose every row has an unmapped country (all IGNORE_INDEX) must not poison the loss
    with a 0/0 → NaN from the aux CE — the aux term is skipped, the BIO loss stands alone."""
    enc = _build_encoder(use_locale_conditioning=True, locale_loss_weight=0.3)
    b = _stub_batch(2, 8)
    labels = torch.zeros(2, 8, dtype=torch.long)
    labels[0, 5:] = IGNORE_INDEX
    locale_ids = torch.full((2,), IGNORE_INDEX, dtype=torch.long)
    out = enc(
        input_ids=b["input_ids"],
        attention_mask=b["attention_mask"],
        labels=labels,
        locale_ids=locale_ids,
    )
    assert out.loss is not None and torch.isfinite(out.loss)


# --- back-compat: conditioning OFF ----------------------------------------------------


def test_conditioning_off_emits_no_locale_logits_and_ignores_locale_ids():
    enc = _build_encoder(use_locale_conditioning=False)
    assert enc.locale_head is None and enc.locale_film is None
    b = _stub_batch(2, 8)
    # Passing locale_ids to an unconditioned encoder is harmless (ignored, not an error) — the
    # data loader always emits them now, so the off path must tolerate them.
    out = enc(
        input_ids=b["input_ids"],
        attention_mask=b["attention_mask"],
        locale_ids=torch.tensor([0, 1], dtype=torch.long),
    )
    assert out.locale_logits is None
    assert out.logits.shape == (2, 8, NUM_LABELS)


# --- save / load round-trip -----------------------------------------------------------


def test_save_load_roundtrip_preserves_locale_config(tmp_path):
    m = _build_encoder(use_locale_conditioning=True, locale_loss_weight=0.3)
    m.save_pretrained(tmp_path)
    loaded = type(m).from_pretrained(tmp_path)
    assert loaded.use_locale_conditioning is True
    assert loaded.num_locales == NUM_LOCALES
    assert loaded.locale_loss_weight == pytest.approx(0.3)
    assert loaded.locale_head is not None and loaded.locale_film is not None
    sd_before, sd_after = m.state_dict(), loaded.state_dict()
    assert set(sd_before) == set(sd_after)
    for k in sd_before:
        assert torch.allclose(sd_before[k], sd_after[k]), f"mismatch on {k}"


def test_load_pre_pr3_card_back_compat(tmp_path):
    """A model card written before PR3 (no locale keys) loads with conditioning OFF."""
    m = _build_encoder(use_locale_conditioning=False)
    m.save_pretrained(tmp_path)
    card = tmp_path / "config.json"
    cfg = json.loads(card.read_text())
    cfg.pop("use_locale_conditioning", None)
    cfg.pop("num_locales", None)
    cfg.pop("locale_loss_weight", None)
    card.write_text(json.dumps(cfg))
    loaded = type(m).from_pretrained(tmp_path)
    assert loaded.use_locale_conditioning is False
    assert loaded.locale_head is None


# --- the cross-pollution tripwire metric ----------------------------------------------


def test_cross_pollution_counts_city_start_as_postcode():
    b_loc = LABEL_TO_ID["B-locality"]
    b_reg = LABEL_TO_ID["B-region"]
    b_pc = LABEL_TO_ID["B-postcode"]
    o = LABEL_TO_ID["O"]
    # 4 gold city/region-start tokens; 1 predicted as postcode → 25%.
    labels = torch.tensor([[b_loc, o, b_reg, o], [b_loc, o, b_reg, o]])
    preds = torch.tensor([[b_pc, o, b_reg, o], [b_loc, o, b_reg, o]])
    row_locale = torch.tensor([LOCALE_TO_ID["US"], LOCALE_TO_ID["DE"]])
    out = _cross_pollution(preds, labels, row_locale)
    assert out["cross_pollution"] == pytest.approx(0.25)
    # Per-locale: the US row had the one pollution (2 starts, 1 polluted = 50%); DE clean.
    assert out["cross_pollution.US"] == pytest.approx(0.5)
    assert out["cross_pollution.DE"] == pytest.approx(0.0)


def test_cross_pollution_empty_when_no_city_tokens():
    o = LABEL_TO_ID["O"]
    labels = torch.tensor([[o, o], [o, o]])
    preds = torch.tensor([[o, o], [o, o]])
    assert _cross_pollution(preds, labels, None) == {}


# --- pilot config loads with the expected scope ---------------------------------------


def test_pilot_config_loads_and_matches_scope():
    from mailwoman_train.config import load_config

    here = Path(__file__).resolve().parent.parent.parent
    cfg = load_config(here / "src/mailwoman_train/configs/v0.9.0-pilot-selfcond.yaml")
    assert cfg.model.use_locale_conditioning is True
    assert cfg.model.locale_loss_weight > 0
    assert cfg.model.crf_loss_weight == 0.0  # CRF off — single variable
    assert cfg.model.label_smoothing == 0.1  # v0.7.2 recipe held
    assert set(cfg.data.country_weights) == {"US", "FR", "DE"}  # the three-way pilot
    # The DE corpus is wired: the overlay dir + the German source weight (no longer a launch TODO).
    assert "v0.4.1-de" in cfg.data.corpus_dir
    assert (cfg.data.source_weights or {}).get("synth-german", 0) > 0
    assert cfg.train.max_steps == 20000  # stop at the early gate
    assert cfg.train.lr_schedule == "constant"
