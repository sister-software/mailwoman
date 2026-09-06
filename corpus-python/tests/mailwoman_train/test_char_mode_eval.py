"""The val eval runs on the char path, where there is no SentencePiece tokenizer.

``char_mode: char`` skips SentencePiece entirely, so ``train.py`` hands ``_eval_val`` a None tokenizer and
``iter_batches`` encodes per character. A type-narrowing guard once refused that None at the first scheduled
eval and stopped every char-mode run at step ``eval_every_steps`` (the v8-cjk-full-2k probe, app
ap-qwf1Im1GBSEAQchY85qNtE, at step 250). This test drives the SHIPPED probe config over a two-row corpus so
the eval path is exercised the way the trainer calls it.
"""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import torch

from mailwoman_train.build_jp_slice import SCHEMA
from mailwoman_train.char_tokenizer import build_char_vocab, save_char_vocab
from mailwoman_train.config import load_config
from mailwoman_train.model import build_model
from mailwoman_train.train import _eval_val

CONFIGS = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train" / "configs"
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


def test_eval_val_runs_without_a_tokenizer_on_the_char_path(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    for split in ("train", "val"):
        (corpus / split).mkdir(parents=True)
        pq.write_table(pa.Table.from_pylist(ROWS, schema=SCHEMA), corpus / split / "part-0000.parquet")
    vocab = build_char_vocab([row["raw"] for row in ROWS], min_count=1)
    vocab_path = corpus / "char-vocab.json"
    save_char_vocab(vocab, vocab_path)

    cfg = load_config(PROBE_2K)
    assert cfg.data.char_mode == "char"
    cfg.data.corpus_dir = str(corpus)
    cfg.data.char_vocab_path = str(vocab_path)
    cfg.data.val_rows = len(ROWS)
    cfg.train.eval_batch_size = len(ROWS)

    model = build_model(cfg, vocab_size=2, pad_token_id=0, char_vocab_size=len(vocab))
    metrics = _eval_val(cfg, None, model, torch.device("cpu"), max_rows=len(ROWS))

    assert metrics["val_rows"] == len(ROWS)
    assert "macro_f1" in metrics
    assert metrics["val_loss"] == metrics["val_loss"]  # not NaN


def test_eval_csv_row_has_one_cell_per_label_set_tag() -> None:
    from mailwoman_train.labels import resolve_label_set
    from mailwoman_train.train import eval_csv_row

    tags = resolve_label_set("stage3-cjk").tags
    header = ["step", "wall_seconds", "train_loss", "lr", "val_loss", "val_macro_f1", *(f"f1.{t}" for t in tags)]
    val = {"val_loss": 0.7, "macro_f1": 0.99, "support_tag.locality_unit": 3, "f1_tag.locality_unit": 0.5}
    row = eval_csv_row(2000, 412.0, val, tags)

    assert len(row) == len(header)
    assert row[header.index("f1.locality_unit")] == "0.500000"
    # No support → an empty cell, never a zero that reads as a model failure.
    assert row[header.index("f1.prefecture")] == ""
