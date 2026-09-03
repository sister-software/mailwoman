"""Per-config label sets (v8 CJK Phase 2 — the 33→47 JP schema activation).

Pins the activation contract: the JP set exists and is exactly STAGE3 + the seven SCHEMA.mdx JP
tags; the default stays byte-identical STAGE3; the char encode path maps JP labels under the JP
set and collapses them to O under the default (no silent cross-set leakage); a JP-headed model
persists and restores ITS OWN label map; and the SP path refuses a non-default set loudly.
"""

from __future__ import annotations

import pytest

from mailwoman_train.char_tokenizer import build_char_vocab, encode_row_units
from mailwoman_train.labels import (
    ACTIVE_BIO_LABELS,
    JP_FINE_TAGS,
    STAGE3_BIO_LABELS,
    STAGE3_JP_BIO_LABELS,
    STAGE3_TAGS,
    resolve_label_set,
)
from mailwoman_train.tokenizer import char_label_array_from_spans

JP = resolve_label_set("stage3-jp")
DEFAULT = resolve_label_set()


def test_jp_set_is_stage3_plus_the_seven() -> None:
    assert DEFAULT.bio_labels == STAGE3_BIO_LABELS == ACTIVE_BIO_LABELS
    assert JP.tags == STAGE3_TAGS + JP_FINE_TAGS
    assert len(JP.bio_labels) == 47
    assert JP.bio_labels == STAGE3_JP_BIO_LABELS
    # The shared prefix is ID-stable: every STAGE3 label keeps its STAGE3 id under the JP set.
    for i, label in enumerate(STAGE3_BIO_LABELS):
        assert JP.label_to_id[label] == i


def test_unknown_set_raises() -> None:
    with pytest.raises(ValueError, match="unknown label_set"):
        resolve_label_set("stage9")


def test_collapse_is_per_set() -> None:
    assert JP.collapse_label("B-prefecture") == "B-prefecture"
    assert DEFAULT.collapse_label("B-prefecture") == "O"  # outside STAGE3 — collapses
    assert JP.collapse_label("B-street") == "B-street"
    assert JP.collapse_label("B-nonsense") == "O"


def test_encode_row_units_maps_jp_labels_under_the_jp_set() -> None:
    raw = "東京都千代田区"
    vocab = build_char_vocab([raw])
    labels = char_label_array_from_spans(raw, [0, 3], [3, 7], ["prefecture", "municipality"])
    spans = [(i, i + 1) for i in range(len(raw))]
    enc = encode_row_units(
        raw,
        spans,
        labels,
        vocab,
        max_units=8,
        max_unit_width=7,
        ctx_chars=3,
        label_to_id=JP.label_to_id,
        collapse=JP.collapse_label,
    )
    assert enc["labels"][0] == JP.label_to_id["B-prefecture"]
    assert enc["labels"][3] == JP.label_to_id["B-municipality"]
    # The SAME row under the default set: JP tags collapse to O — never a silent cross-set id.
    enc_default = encode_row_units(raw, spans, labels, vocab, max_units=8, max_unit_width=7, ctx_chars=3)
    assert enc_default["labels"][0] == DEFAULT.label_to_id["O"]


def test_jp_headed_model_round_trips_its_label_map(tmp_path) -> None:
    pytest.importorskip("torch")
    from mailwoman_train.model import MailwomanCoarseEncoder

    model = MailwomanCoarseEncoder(
        vocab_size=2,
        hidden_size=32,
        num_hidden_layers=1,
        num_attention_heads=4,
        intermediate_size=64,
        max_position_embeddings=16,
        hidden_dropout_prob=0.0,
        num_labels=len(JP.bio_labels),
        pad_token_id=0,
        use_crf=False,
        use_char_embed=True,
        char_vocab_size=16,
        id_to_label=JP.id_to_label,
    )
    model.save_pretrained(tmp_path)
    restored = MailwomanCoarseEncoder.from_pretrained(tmp_path)
    assert restored.num_labels == 47
    assert restored.id_to_label == JP.id_to_label
    assert restored.id_to_label[len(JP.bio_labels) - 1] == "I-building_name"


def test_wide_head_without_a_map_raises() -> None:
    pytest.importorskip("torch")
    from mailwoman_train.model import MailwomanCoarseEncoder

    with pytest.raises(ValueError, match="pass id_to_label"):
        MailwomanCoarseEncoder(
            vocab_size=2,
            hidden_size=32,
            num_hidden_layers=1,
            num_attention_heads=4,
            intermediate_size=64,
            max_position_embeddings=16,
            hidden_dropout_prob=0.0,
            num_labels=47,
            pad_token_id=0,
            use_crf=False,
        )


def test_sp_path_refuses_a_non_default_set() -> None:
    import random

    from mailwoman_train.config import DataConfig
    from mailwoman_train.data_loader import iter_encoded

    cfg = DataConfig(corpus_dir="/nonexistent", label_set="stage3-jp", char_mode="off")
    with pytest.raises(ValueError, match="only supported with data.char_mode"):
        list(iter_encoded(cfg, tokenizer=None, rng=random.Random(0)))
