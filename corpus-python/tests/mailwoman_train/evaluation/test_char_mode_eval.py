"""The val eval runs on the char path, where there is no SentencePiece tokenizer.

``char_mode: char`` skips SentencePiece entirely, so ``train.py`` hands ``_eval_val`` a None tokenizer and
``iter_batches`` encodes per character. A type-narrowing guard once refused that None at the first scheduled
eval and stopped every char-mode run at step ``eval_every_steps`` (the v8-cjk-full-2k probe, app
ap-qwf1Im1GBSEAQchY85qNtE, at step 250). This test drives the shipped probe config over a two-row corpus so
the eval path is exercised the way the trainer calls it.
"""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pytest
import torch

from mailwoman_train.config import load_config
from mailwoman_train.corpora.builder import SCHEMA
from mailwoman_train.nn.encoder import build_model
from mailwoman_train.tokenizer.char import build_char_vocab, save_char_vocab
from mailwoman_train.train import validation
from mailwoman_train.train.trainer import _eval_val
from tests import paths
from tests.corpus_fixture import write_corpus_parquet

CONFIGS = paths.CONFIGS
PROBE_2K = CONFIGS / "v8-cjk-full-2k.yaml"

ROWS = [
    {
        "raw": "赵光三分场二十九队, Inner Mongolia, China",
        "tokens": ["赵", "光", "三", "分", "场", "二", "十", "九", "队", "Inner", "Mongolia", "China"],
        "labels": ["B-dependent_locality"] + ["I-locality_unit"] * 8 + ["B-region", "I-region", "B-country"],
        "span_starts": [0, 2, 11, 27],
        "span_ends": [2, 9, 25, 32],
        "span_tags": ["dependent_locality", "locality_unit", "region", "country"],
        "country": "CN",
        "source": "coarse-placer-cn-units",
        "register": "cn-units",
    },
    {
        "raw": "東京都千代田区丸の内1",
        "tokens": ["東京都千代田区丸の内1"],
        "labels": ["B-prefecture"],
        "span_starts": [0, 3, 7],
        "span_ends": [3, 7, 10],
        "span_tags": ["prefecture", "municipality", "district"],
        "country": "JP",
        "source": "overture-jp",
        "register": "native",
    },
]


def _char_probe(tmp_path: Path, batch_size: int = len(ROWS)):  # type: ignore[no-untyped-def]
    """The shipped char probe config over a two-row corpus, and a model built from it."""
    corpus = tmp_path / "corpus"
    for split in ("train", "val"):
        (corpus / split).mkdir(parents=True)
        write_corpus_parquet(pa.Table.from_pylist(ROWS, schema=SCHEMA), corpus / split / "part-0000.parquet")
    vocab = build_char_vocab([row["raw"] for row in ROWS], min_count=1)
    vocab_path = corpus / "char-vocab.json"
    save_char_vocab(vocab, vocab_path)

    cfg = load_config(PROBE_2K)
    assert cfg.data.char_mode == "char"
    cfg.data.corpus_dir = str(corpus)
    cfg.data.char_vocab_path = str(vocab_path)
    cfg.data.val_rows = len(ROWS)
    cfg.train.eval_batch_size = batch_size
    model = build_model(cfg, vocab_size=2, pad_token_id=0, char_vocab_size=len(vocab))
    return cfg, model


def test_eval_val_runs_without_a_tokenizer_on_the_char_path(tmp_path: Path) -> None:
    cfg, model = _char_probe(tmp_path)
    metrics = _eval_val(cfg, None, model, torch.device("cpu"), max_rows=len(ROWS))

    assert metrics["val_rows"] == len(ROWS)
    assert "macro_f1" in metrics
    assert metrics["val_loss"] == metrics["val_loss"]  # not NaN


def test_a_cached_validation_draw_replays_the_same_batches_and_metrics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg, model = _char_probe(tmp_path, batch_size=1)
    device = torch.device("cpu")
    uncached = _eval_val(cfg, None, model, device, max_rows=len(ROWS))

    encodes = 0
    real = validation.iter_batches

    def counting(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal encodes
        encodes += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(validation, "iter_batches", counting)
    draw = validation.ValidationDraw()
    first = _eval_val(cfg, None, model, device, max_rows=len(ROWS), draw=draw)
    second = _eval_val(cfg, None, model, device, max_rows=len(ROWS), draw=draw)

    # The draw is encoded once and replayed, and every evaluation reports what an uncached one does.
    assert encodes == 1
    assert first == second == uncached
    fresh = validation.validation_batches(cfg, None, len(ROWS))
    cached = draw.batches(cfg, None, len(ROWS))
    assert len(cached) == len(fresh) == len(ROWS)
    for a, b in zip(cached, fresh, strict=True):
        assert a.keys() == b.keys()
        assert all(torch.equal(a[name], b[name]) for name in a)


def test_eval_csv_row_has_one_cell_per_label_set_tag() -> None:
    from mailwoman_train.evaluation.metrics import eval_csv_row
    from mailwoman_train.labels import resolve_label_set

    tags = resolve_label_set("stage3-cjk").tags
    header = [
        "step",
        "wall_seconds",
        "train_loss",
        "lr",
        "val_loss",
        "val_macro_f1",
        *(f"f1.{t}" for t in tags),
        *(f"support.{t}" for t in tags),
    ]
    val = {"val_loss": 0.7, "macro_f1": 0.99, "support_tag.locality_unit": 3, "f1_tag.locality_unit": 0.5}
    row = eval_csv_row(2000, 412.0, val, tags)

    assert len(row) == len(header)
    assert row[header.index("f1.locality_unit")] == "0.500000"
    # The support cell is the denominator behind the F1 beside it.
    assert row[header.index("support.locality_unit")] == 3
    # No support → an empty F1 cell, never a zero that reads as a model failure, and a support of 0.
    assert row[header.index("f1.prefecture")] == ""
    assert row[header.index("support.prefecture")] == 0
