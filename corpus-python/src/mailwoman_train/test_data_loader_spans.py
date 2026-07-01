"""Loader wiring for the v0.5.0 char-offset span triple (#519, rebuild-plan step 4).

Pins the loader-side contract:

1. Rows from a span-schema shard stream the triple end-to-end — ``iter_rows`` carries it,
   ``iter_encoded`` hands it to ``encode_row`` (which trains FROM the spans).
2. Frozen pre-v0.5.0 shards (no span columns) ride the legacy token path: no span keys appear.
3. Corruption is LOUD, never a silent fallback: a shard with a partial span-column set raises,
   and a null span value inside a span-schema shard raises naming the row.
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mailwoman_train import data_loader
from mailwoman_train.config import DataConfig
from mailwoman_train.data_loader import iter_encoded, iter_rows

FULL_SCHEMA = pa.schema(
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


def _row(**over) -> dict:
    base = {
        "raw": "P.O. Box 19, Buffalo, NY 14201",
        "tokens": ["P", "O", "Box", "19", "Buffalo", "NY", "14201"],
        "labels": ["B-po_box", "I-po_box", "I-po_box", "I-po_box", "B-locality", "B-region", "B-postcode"],
        "span_starts": [0, 13, 22, 25],
        "span_ends": [11, 20, 24, 30],
        "span_tags": ["po_box", "locality", "region", "postcode"],
        "country": "US",
        "source": "test",
    }
    base.update(over)
    return base


def _write_corpus(tmp_path: Path, rows: list[dict], drop_columns: tuple[str, ...] = ()) -> Path:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    schema = FULL_SCHEMA
    for col in drop_columns:
        schema = schema.remove(schema.get_field_index(col))
    table = pa.Table.from_pylist([{k: r.get(k) for k in schema.names} for r in rows], schema=schema)
    pq.write_table(table, corpus / "train" / "part-0000.parquet")
    return corpus


def _iter(corpus: Path) -> list[dict]:
    return list(
        iter_rows(
            corpus,
            "train",
            rng=random.Random(0),
            country_weights={"US": 1.0},
            coarse_filter=False,
            shuffle_buffer=4,
        )
    )


def test_span_shard_rows_carry_the_triple(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path, [_row()])
    rows = _iter(corpus)
    assert len(rows) == 1
    assert rows[0]["span_starts"] == [0, 13, 22, 25]
    assert rows[0]["span_ends"] == [11, 20, 24, 30]
    assert rows[0]["span_tags"] == ["po_box", "locality", "region", "postcode"]


def test_legacy_shard_rows_have_no_span_keys(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path, [_row()], drop_columns=("span_starts", "span_ends", "span_tags"))
    rows = _iter(corpus)
    assert len(rows) == 1
    assert "span_starts" not in rows[0]


def test_partial_span_columns_raise(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path, [_row()], drop_columns=("span_tags",))
    with pytest.raises(ValueError, match="all-or-none"):
        _iter(corpus)


def test_null_span_value_in_span_shard_raises(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path, [_row(), _row(raw="123 Main St", span_starts=None)])
    with pytest.raises(ValueError, match="null span column"):
        _iter(corpus)


def test_empty_triple_is_a_valid_all_o_row(tmp_path: Path) -> None:
    corpus = _write_corpus(
        tmp_path,
        [
            _row(
                raw="hello world",
                tokens=["hello", "world"],
                labels=["O", "O"],
                span_starts=[],
                span_ends=[],
                span_tags=[],
            )
        ],
    )
    rows = _iter(corpus)
    assert rows[0]["span_starts"] == []


def test_augmentation_plus_relabel_keep_spans_consistent_end_to_end(tmp_path: Path) -> None:
    """The mutation-upstream hazard, pinned at the loader level: with the directional expansion
    AND the #511 relabel both on, every emitted row's spans must address ITS OWN raw."""
    from mailwoman_train.relabel import AffixRelabelLexicon

    corpus = _write_corpus(
        tmp_path,
        [
            _row(
                raw="1234 SE Division St",
                tokens=["1234", "SE", "Division", "St"],
                labels=["B-house_number", "B-street", "I-street", "I-street"],
                span_starts=[0, 5],
                span_ends=[4, 19],
                span_tags=["house_number", "street"],
            )
        ],
    )
    lex = AffixRelabelLexicon(
        directionals={"se": "SE", "southeast": "SE"},
        suffixes={"st": "STREET", "street": "STREET"},
        version="test",
    )
    rows = list(
        iter_rows(
            corpus,
            "train",
            rng=random.Random(0),
            country_weights={"US": 1.0},
            coarse_filter=False,
            shuffle_buffer=4,
            augment_directional_prob=1.0,
            affix_relabel_lexicon=lex,
        )
    )
    assert len(rows) == 2  # original + expanded copy

    def slices(r: dict) -> list[tuple[str, str]]:
        return [(t, r["raw"][s:e]) for s, e, t in zip(r["span_starts"], r["span_ends"], r["span_tags"], strict=True)]

    for r in rows:
        for s, e in zip(r["span_starts"], r["span_ends"], strict=True):
            assert 0 <= s < e <= len(r["raw"])

    original = next(r for r in rows if r["raw"] == "1234 SE Division St")
    assert slices(original) == [
        ("house_number", "1234"),
        ("street_prefix", "SE"),
        ("street", "Division"),
        ("street_suffix", "St"),
    ]
    expanded = next(r for r in rows if "Southeast" in r["raw"])
    assert expanded["raw"] == "1234 Southeast Division St"
    assert slices(expanded) == [
        ("house_number", "1234"),
        ("street_prefix", "Southeast"),
        ("street", "Division"),
        ("street_suffix", "St"),
    ]


def test_iter_encoded_hands_the_triple_to_encode_row(tmp_path: Path, monkeypatch) -> None:
    corpus = _write_corpus(tmp_path, [_row()])
    captured: list[dict] = []

    def fake_encode_row(tokenizer, raw, tokens, labels, max_length, **kwargs):
        captured.append({"raw": raw, **kwargs})
        return {"input_ids": [1], "attention_mask": [1], "labels": [0]}

    monkeypatch.setattr(data_loader, "encode_row", fake_encode_row)
    cfg = DataConfig(corpus_dir=str(corpus), country_weights={"US": 1.0}, coarse_filter=False)
    list(iter_encoded(cfg, tokenizer=None, split="train"))
    assert len(captured) == 1
    assert captured[0]["span_starts"] == [0, 13, 22, 25]
    assert captured[0]["span_ends"] == [11, 20, 24, 30]
    assert captured[0]["span_tags"] == ["po_box", "locality", "region", "postcode"]


def test_iter_encoded_legacy_path_passes_none(tmp_path: Path, monkeypatch) -> None:
    corpus = _write_corpus(tmp_path, [_row()], drop_columns=("span_starts", "span_ends", "span_tags"))
    captured: list[dict] = []

    def fake_encode_row(tokenizer, raw, tokens, labels, max_length, **kwargs):
        captured.append(kwargs)
        return {"input_ids": [1], "attention_mask": [1], "labels": [0]}

    monkeypatch.setattr(data_loader, "encode_row", fake_encode_row)
    cfg = DataConfig(corpus_dir=str(corpus), country_weights={"US": 1.0}, coarse_filter=False)
    list(iter_encoded(cfg, tokenizer=None, split="train"))
    assert captured[0]["span_starts"] is None
    assert captured[0]["span_tags"] is None


def test_iter_encoded_skips_astral_utf16_offset_rows(tmp_path: Path, monkeypatch) -> None:
    # The corpus stores UTF-16 span offsets (#519); this consumer is code-point-native. An astral-
    # script row (Gothic — 2 UTF-16 units per code point) has span ends that exceed the code-point
    # len(raw), so encode_row would raise span-out-of-bounds. iter_encoded must skip it, not crash.
    astral = _row(
        raw="𐍃𐌿𐌽𐌸",  # 4 code points, 8 UTF-16 units
        tokens=["𐍃𐌿𐌽𐌸"],
        labels=["B-country"],
        span_starts=[0],
        span_ends=[8],  # UTF-16 end > code-point len(raw)=4
        span_tags=["country"],
    )
    corpus = _write_corpus(tmp_path, [_row(), astral])
    captured: list[dict] = []

    def fake_encode_row(tokenizer, raw, tokens, labels, max_length, **kwargs):
        captured.append({"raw": raw, **kwargs})
        return {"input_ids": [1], "attention_mask": [1], "labels": [0]}

    monkeypatch.setattr(data_loader, "encode_row", fake_encode_row)
    cfg = DataConfig(corpus_dir=str(corpus), country_weights={"US": 1.0}, coarse_filter=False)
    list(iter_encoded(cfg, tokenizer=None, split="train"))
    # Only the BMP row reached encode_row; the astral row was skipped before it (no crash).
    assert len(captured) == 1
    assert captured[0]["raw"] == "P.O. Box 19, Buffalo, NY 14201"
