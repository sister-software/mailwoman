"""P0 validation-stream policy (2026-08-09 training-substrate audit, HANDOFF-CODEX-TO-CLAUDE §6).

Two defects pinned here:

1. **Mixed-source shards lose rows.** The loader identifies a shard's source from its FIRST
   row, buckets the whole shard under it, then filters every row to that source — so in a
   mixed-source validation shard every later-source row is silently discarded. "3 val shards"
   was never a coverage receipt.
2. **Training policy leaks into validation.** ``iter_rows`` applies the same augmentation
   probabilities, affix-relabel pass, and source weights regardless of split, so the headline
   validation metric scores an augmented, training-filtered slice, not held-out data.

Contract pinned here (the repair): for any split other than ``"train"``, ``iter_rows``
yields EVERY row of every shard exactly as authored — no source bucketing/filtering, no
source weighting, no augmentation, no online label mutation.
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from mailwoman_train.data_loader import iter_rows
from mailwoman_train.relabel import AffixRelabelLexicon

LEGACY_SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
    ]
)


def _row(raw: str, source: str, labels: list[str] | None = None) -> dict:
    tokens = raw.split(" ")
    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels if labels is not None else ["O"] * len(tokens),
        "country": "US",
        "source": source,
    }


def _write_split(corpus: Path, split: str, shards: dict[str, list[dict]]) -> None:
    (corpus / split).mkdir(parents=True, exist_ok=True)
    for name, rows in shards.items():
        pq.write_table(pa.Table.from_pylist(rows, schema=LEGACY_SCHEMA), corpus / split / name)


def _val_rows(corpus: Path, **overrides) -> list[dict]:
    kwargs = {
        "rng": random.Random(0),
        "country_weights": {"US": 1.0},
        "coarse_filter": False,
        "shuffle_buffer": 4,
    }
    kwargs.update(overrides)
    return list(iter_rows(corpus, "val", **kwargs))


def test_val_yields_every_row_of_a_mixed_source_shard(tmp_path: Path) -> None:
    """One shard, source flips from 'a' to 'b' mid-shard: all 10 rows must come out.
    Today the shard is bucketed under 'a' (row 0's source) and the 5 'b' rows vanish."""
    corpus = tmp_path / "corpus"
    rows = [_row(f"{i} Alpha St", "a") for i in range(5)] + [_row(f"{i} Beta St", "b") for i in range(5)]
    _write_split(corpus, "val", {"part-mixed.parquet": rows})

    out = _val_rows(corpus)
    assert len(out) == 10, f"expected all 10 rows of the mixed-source shard, got {len(out)}"
    assert {r["source"] for r in out} == {"a", "b"}


def test_val_ignores_training_source_weights(tmp_path: Path) -> None:
    """``source_weights`` describes the desired TRAIN mixture. Passing it through to the
    validation split reweights/drops held-out rows (a zero weight deletes a source outright)."""
    corpus = tmp_path / "corpus"
    _write_split(
        corpus,
        "val",
        {
            "part-a.parquet": [_row(f"{i} Alpha St", "a") for i in range(5)],
            "part-b.parquet": [_row(f"{i} Beta St", "b") for i in range(5)],
        },
    )

    out = _val_rows(corpus, source_weights={"a": 1.0, "b": 0.0})
    assert len(out) == 10, f"source_weights leaked into the val split: got {len(out)}/10 rows"
    assert {r["source"] for r in out} == {"a", "b"}


def test_val_receives_no_augmentation(tmp_path: Path) -> None:
    """Augmentation probabilities are a TRAIN policy. At prob 1.0 today every val row is
    mutated (upper-cased here); the val stream must be byte-identical to the authored rows."""
    corpus = tmp_path / "corpus"
    authored = [_row(f"{i} Quiet Lane", "a") for i in range(6)]
    _write_split(corpus, "val", {"part-a.parquet": authored})

    out = _val_rows(corpus, augment_upper_case_prob=1.0)
    assert len(out) == 6
    assert sorted(r["raw"] for r in out) == sorted(r["raw"] for r in authored)


def test_val_receives_no_affix_relabel(tmp_path: Path) -> None:
    """The #511 affix relabel is an online TRAIN-label policy (and was the #1569 corruption
    vector). Val labels must leave the loader exactly as authored. The train leg of this test
    proves the lexicon DOES fire on the same row — so a silent no-op lexicon can't fake a pass."""
    lex = AffixRelabelLexicon(directionals={"west": "W"}, suffixes={"road": "Rd"}, version="test")
    street_labels = ["B-street", "I-street", "I-street"]
    corpus = tmp_path / "corpus"
    _write_split(corpus, "val", {"part-a.parquet": [_row("Menlo Park Road", "a", labels=street_labels)]})
    _write_split(corpus, "train", {"part-a.parquet": [_row("Menlo Park Road", "a", labels=street_labels)]})

    train_out = list(
        iter_rows(
            corpus,
            "train",
            rng=random.Random(0),
            country_weights={"US": 1.0},
            coarse_filter=False,
            affix_relabel_lexicon=lex,
            shuffle_buffer=1,
        )
    )
    assert train_out[0]["labels"] == ["B-street", "I-street", "B-street_suffix"], (
        "sanity leg: the lexicon must fire on the train split for this test to mean anything"
    )

    val_out = _val_rows(corpus, affix_relabel_lexicon=lex, shuffle_buffer=1)
    assert val_out[0]["labels"] == street_labels, f"affix relabel leaked into the val split: {val_out[0]['labels']}"
