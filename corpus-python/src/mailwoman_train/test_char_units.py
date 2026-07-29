"""The v8 CJK char path: ``encode_row_units`` + the loader's ``char_mode`` branch (D1–D6).

Pins the contract the JP probe trains under (docs/superpowers/plans/2026-07-18-v8-jp-char-encoder-
design.md): ``char_ids (S, W)`` with S = label units / W = positional composition window; char mode
is one unit per character with per-char B/I used as-is; word mode is one unit per whitespace token
with B/I re-flipped per unit; the loader's char branch skips SentencePiece, REQUIRES span-schema
shards, and refuses any per-SP-piece channel configuration.
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train.char_tokenizer import (
    PAD_CHAR_ID,
    UNK_CHAR_ID,
    build_char_vocab,
    encode_row_charword,
    encode_row_units,
    save_char_vocab,
)
from mailwoman_train.config import DataConfig
from mailwoman_train.data_loader import iter_encoded
from mailwoman_train.labels import IGNORE_INDEX, LABEL_TO_ID
from mailwoman_train.tokenizer import char_label_array_from_spans, whitespace_spans

# ---------------------------------------------------------------------------- encode_row_units


def _vocab(text: str) -> dict[str, int]:
    return build_char_vocab([text])


def test_char_mode_window_is_positional() -> None:
    """Slot j of unit (i, i+1) is raw[i - ctx + j]; out-of-bounds slots hold PAD in place."""
    raw = "東京都千代田区"
    vocab = _vocab(raw)
    labels = ["B-region", "I-region", "I-region", "B-locality", "I-locality", "I-locality", "I-locality"]
    enc = encode_row_units(
        raw,
        [(i, i + 1) for i in range(len(raw))],
        labels,
        vocab,
        max_units=16,
        max_unit_width=7,
        ctx_chars=3,
    )
    assert len(enc["char_ids"]) == 16
    assert enc["attention_mask"] == [1] * 7 + [0] * 9
    # Unit 0 (東): window covers raw[-3:4] — three leading PAD slots, then 東京都千.
    row0 = enc["char_ids"][0]
    assert row0[:3] == [PAD_CHAR_ID] * 3
    assert row0[3:] == [vocab[c] for c in "東京都千"]
    # Unit 3 (千): fully interior — the window is exactly raw[0:7].
    assert enc["char_ids"][3] == [vocab[c] for c in "東京都千代田区"]
    # Unit 6 (区): three trailing PAD slots.
    row6 = enc["char_ids"][6]
    assert row6[:4] == [vocab[c] for c in "千代田区"]
    assert row6[4:] == [PAD_CHAR_ID] * 3


def test_char_mode_labels_are_per_char_as_is() -> None:
    """Char units keep the per-char array's own B/I — no re-flip (D3)."""
    raw = "青森市"
    vocab = _vocab(raw)
    labels = char_label_array_from_spans(raw, [0], [3], ["locality"])
    enc = encode_row_units(
        raw, [(i, i + 1) for i in range(3)], labels, vocab, max_units=4, max_unit_width=3, ctx_chars=1
    )
    assert enc["labels"][:3] == [
        LABEL_TO_ID["B-locality"],
        LABEL_TO_ID["I-locality"],
        LABEL_TO_ID["I-locality"],
    ]
    assert enc["labels"][3] == IGNORE_INDEX


def test_char_mode_whitespace_units_carry_o() -> None:
    raw = "〒100 東京"
    vocab = _vocab(raw)
    labels = char_label_array_from_spans(raw, [0, 5], [4, 7], ["postcode", "region"])
    enc = encode_row_units(
        raw, [(i, i + 1) for i in range(len(raw))], labels, vocab, max_units=8, max_unit_width=3, ctx_chars=1
    )
    assert enc["labels"][4] == LABEL_TO_ID["O"]  # the space between 100 and 東京
    assert enc["attention_mask"][4] == 1  # still a real position (offset alignment)


def test_word_mode_bi_comes_straight_from_the_span_array() -> None:
    """Continuation tokens read I from the char array; adjacent same-family spans keep their B."""
    raw = "main st buffalo"
    vocab = _vocab(raw)
    labels = char_label_array_from_spans(raw, [0, 8], [7, 15], ["street", "locality"])
    spans = whitespace_spans(raw, ["main", "st", "buffalo"])
    enc = encode_row_units(raw, spans, labels, vocab, max_units=4, max_unit_width=8, ctx_chars=0)
    # "st" starts mid-span → its first char is I-street; the entity's B/I needs no re-flip.
    assert enc["labels"][:3] == [
        LABEL_TO_ID["B-street"],
        LABEL_TO_ID["I-street"],
        LABEL_TO_ID["B-locality"],
    ]
    # Two ADJACENT street spans (distinct entities): each keeps its own B — the boundary a
    # contiguous-family re-flip would have destroyed.
    labels = char_label_array_from_spans(raw, [0, 5, 8], [4, 7, 15], ["street", "street", "locality"])
    enc = encode_row_units(raw, spans, labels, vocab, max_units=4, max_unit_width=8, ctx_chars=0)
    assert enc["labels"][:3] == [
        LABEL_TO_ID["B-street"],
        LABEL_TO_ID["B-street"],
        LABEL_TO_ID["B-locality"],
    ]


def test_word_mode_ctx0_matches_encode_row_charword() -> None:
    """The ctx=0 word path reproduces the frozen #825 probe encoder on a clean row."""
    raw = "main st buffalo"
    tokens = ["main", "st", "buffalo"]
    token_labels = ["B-street", "I-street", "B-locality"]
    vocab = _vocab(raw)
    legacy = encode_row_charword(raw, tokens, token_labels, vocab, max_tokens=5, max_word_len=8)
    labels = char_label_array_from_spans(raw, [0, 8], [7, 15], ["street", "locality"])
    new = encode_row_units(
        raw,
        whitespace_spans(raw, tokens),
        labels,
        vocab,
        max_units=5,
        max_unit_width=8,
        ctx_chars=0,
    )
    assert new == legacy


def test_unknown_chars_map_to_unk_and_width_truncates() -> None:
    raw = "abcdef zz"
    vocab = build_char_vocab(["abcdef"])  # 'z' and ' ' unseen
    labels = ["O"] * len(raw)
    enc = encode_row_units(
        raw, whitespace_spans(raw, ["abcdef", "zz"]), labels, vocab, max_units=2, max_unit_width=4, ctx_chars=0
    )
    assert enc["char_ids"][0] == [vocab[c] for c in "abcd"]  # truncated at W=4
    assert enc["char_ids"][1] == [UNK_CHAR_ID, UNK_CHAR_ID, PAD_CHAR_ID, PAD_CHAR_ID]


def test_unit_truncation_at_max_units() -> None:
    raw = "a b c"
    vocab = _vocab(raw)
    enc = encode_row_units(
        raw,
        whitespace_spans(raw, ["a", "b", "c"]),
        ["O"] * len(raw),
        vocab,
        max_units=2,
        max_unit_width=2,
        ctx_chars=0,
    )
    assert len(enc["char_ids"]) == 2
    assert enc["attention_mask"] == [1, 1]


# ---------------------------------------------------------------------------- loader char branch

SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("span_starts", pa.list_(pa.int32())),
        ("span_ends", pa.list_(pa.int32())),
        ("span_tags", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
    ]
)

JP_ROW = {
    "raw": "青森県青森市中央1-22-5",
    "tokens": ["青森県青森市中央1-22-5"],
    "labels": ["B-region"],
    "span_starts": [0, 3, 6, 8],
    "span_ends": [3, 6, 8, 14],
    "span_tags": ["region", "locality", "street", "house_number"],
    "country": "JP",
    "source": "overture-jp",
}


def _write_corpus(tmp_path: Path, rows: list[dict], schema: pa.Schema = SCHEMA) -> Path:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    table = pa.Table.from_pylist([{k: r.get(k) for k in schema.names} for r in rows], schema=schema)
    pq.write_table(table, corpus / "train" / "part-0000.parquet")
    return corpus


def _char_cfg(tmp_path: Path, corpus: Path, **over) -> DataConfig:
    vocab_path = tmp_path / "char-vocab.json"
    save_char_vocab(build_char_vocab([JP_ROW["raw"]]), vocab_path)
    base = dict(
        corpus_dir=str(corpus),
        char_mode="char",
        char_vocab_path=str(vocab_path),
        char_ctx=3,
        max_unit_width=7,
        max_units=32,
        country_weights={"JP": 1.0},
        coarse_filter=False,
    )
    base.update(over)
    return DataConfig(**base)


def test_loader_char_mode_yields_unit_tensors(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path, [JP_ROW])
    [ex] = list(iter_encoded(_char_cfg(tmp_path, corpus), tokenizer=None, rng=random.Random(0)))
    n = len(JP_ROW["raw"])
    assert ex.char_ids is not None
    assert len(ex.char_ids) == 32
    assert len(ex.char_ids[0]) == 7
    assert ex.attention_mask == [1] * n + [0] * (32 - n)
    assert ex.input_ids == [0] * 32  # dummy pad row — never read by the char-embed branch
    # Per-char BIO straight from the span triple: B at each span start, I inside.
    assert ex.labels[0] == LABEL_TO_ID["B-region"]
    assert ex.labels[1] == LABEL_TO_ID["I-region"]
    assert ex.labels[3] == LABEL_TO_ID["B-locality"]
    assert ex.labels[8] == LABEL_TO_ID["B-house_number"]
    assert ex.labels[13] == LABEL_TO_ID["I-house_number"]
    assert ex.labels[n:] == [IGNORE_INDEX] * (32 - n)


def test_loader_char_mode_requires_span_schema(tmp_path: Path) -> None:
    schema = SCHEMA.remove(SCHEMA.get_field_index("span_starts"))
    schema = schema.remove(schema.get_field_index("span_ends"))
    schema = schema.remove(schema.get_field_index("span_tags"))
    corpus = _write_corpus(tmp_path, [JP_ROW], schema=schema)
    with pytest.raises(ValueError, match="span-schema"):
        list(iter_encoded(_char_cfg(tmp_path, corpus), tokenizer=None, rng=random.Random(0)))


def test_loader_char_mode_refuses_channel_paths(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path, [JP_ROW])
    cfg = _char_cfg(tmp_path, corpus, street_type_lexicon_path="/nonexistent/lexicon.json")
    with pytest.raises(ValueError, match="channel-free"):
        list(iter_encoded(cfg, tokenizer=None, rng=random.Random(0)))


def test_loader_char_mode_narrow_window_raises(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path, [JP_ROW])
    cfg = _char_cfg(tmp_path, corpus, max_unit_width=5)  # < 2*3 + 1
    with pytest.raises(ValueError, match="truncates the char window"):
        list(iter_encoded(cfg, tokenizer=None, rng=random.Random(0)))


def test_char_batch_trains_a_char_embed_model(tmp_path: Path) -> None:
    """End-to-end: loader char batch → collate → tensors → use_char_embed forward → finite loss."""
    torch = pytest.importorskip("torch")

    from mailwoman_train.data_loader import collate
    from mailwoman_train.labels import ACTIVE_BIO_LABELS
    from mailwoman_train.model import MailwomanCoarseEncoder

    corpus = _write_corpus(tmp_path, [JP_ROW])
    cfg = _char_cfg(tmp_path, corpus)
    [ex] = list(iter_encoded(cfg, tokenizer=None, rng=random.Random(0)))
    batch = collate([ex])
    model = MailwomanCoarseEncoder(
        vocab_size=2,
        hidden_size=32,
        num_hidden_layers=1,
        num_attention_heads=4,
        intermediate_size=64,
        max_position_embeddings=32,
        hidden_dropout_prob=0.0,
        num_labels=len(ACTIVE_BIO_LABELS),
        pad_token_id=0,
        use_crf=False,
        use_char_embed=True,
        char_vocab_size=64,
    )
    out = model(
        input_ids=torch.tensor(batch["input_ids"], dtype=torch.long),
        attention_mask=torch.tensor(batch["attention_mask"], dtype=torch.long),
        labels=torch.tensor(batch["labels"], dtype=torch.long),
        char_ids=torch.tensor(batch["char_ids"], dtype=torch.long),
    )
    assert torch.isfinite(out.loss)
    assert out.logits.shape == (1, 32, len(ACTIVE_BIO_LABELS))
