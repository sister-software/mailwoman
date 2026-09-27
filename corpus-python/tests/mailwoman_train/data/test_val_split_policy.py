from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from mailwoman_train.data.loader import iter_rows
from mailwoman_train.data.relabel import AffixRelabelLexicon

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


def _write_split(corpus: Path, split: str, files: dict[str, list[dict]]) -> None:
    (corpus / split).mkdir(parents=True, exist_ok=True)
    for name, rows in files.items():
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


def test_val_yields_every_row_of_a_mixed_source_file(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    rows = [_row(f"{i} Alpha St", "a") for i in range(5)] + [_row(f"{i} Beta St", "b") for i in range(5)]
    _write_split(corpus, "val", {"part-mixed.parquet": rows})

    out = _val_rows(corpus)
    assert len(out) == 10, f"expected all 10 rows of the mixed-source file, got {len(out)}"
    assert {r["source"] for r in out} == {"a", "b"}


def test_val_ignores_training_source_weights(tmp_path: Path) -> None:
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
    corpus = tmp_path / "corpus"
    authored = [_row(f"{i} Quiet Lane", "a") for i in range(6)]
    _write_split(corpus, "val", {"part-a.parquet": authored})

    out = _val_rows(corpus, augment_upper_case_prob=1.0)
    assert len(out) == 6
    assert sorted(r["raw"] for r in out) == sorted(r["raw"] for r in authored)


def test_val_receives_no_affix_relabel(tmp_path: Path) -> None:
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
