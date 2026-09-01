"""Augmentation-pool exclusion (2026-08-10 recipe review, lever 12).

Augmented copies fill 25.5% of the emitted row budget (full-epoch mixture audit), and copies
of an OVERSAMPLED synthetic slice are near-duplicates that compound its repetition dose while
adding none of the diversity that moves OOD boards (Hernandez 2022 × Chen 2024). Contract:
``augment_exclude_sources`` lists sources whose rows pass through the augmentation stage
untouched — original emitted exactly once, no copies — while every other source keeps the
configured augmentation policy. The affix relabel still applies to excluded sources (label
policy and augmentation policy are independent).
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from mailwoman_train.data_loader import iter_rows

LEGACY_SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
    ]
)


def _rows(source: str, n: int) -> list[dict]:
    return [
        {
            "raw": f"{i} quiet lane {source}",
            "tokens": [str(i), "quiet", "lane", source],
            "labels": ["O", "O", "O", "O"],
            "country": "US",
            "source": source,
        }
        for i in range(n)
    ]


def _write_corpus(tmp_path: Path) -> Path:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    for name, rows in (
        ("part-slice.parquet", _rows("synth-suffix-boundary", 8)),
        ("part-a.parquet", _rows("tiger", 8)),
    ):
        pq.write_table(pa.Table.from_pylist(rows, schema=LEGACY_SCHEMA), corpus / "train" / name)
    return corpus


def _emit(corpus: Path, **overrides) -> list[dict]:
    kwargs = {
        "rng": random.Random(0),
        "country_weights": {"US": 1.0},
        "source_weights": {"synth-suffix-boundary": 1.0, "tiger": 1.0},
        "coarse_filter": False,
        "augment_upper_case_prob": 1.0,
        "shuffle_buffer": 1,
    }
    kwargs.update(overrides)
    return list(iter_rows(corpus, "train", **kwargs))


def test_excluded_source_rows_are_never_augmented(tmp_path: Path) -> None:
    out = _emit(_write_corpus(tmp_path), augment_exclude_sources=["synth-suffix-boundary"])

    slice_rows = [r for r in out if r["source"] == "synth-suffix-boundary"]
    other_rows = [r for r in out if r["source"] == "tiger"]

    assert slice_rows, "sanity: the excluded source must still be sampled"
    assert all(r["raw"] == r["raw"].lower() for r in slice_rows), "an upper-cased copy leaked from the excluded source"
    # The non-excluded source keeps the policy: at prob 1.0 every draw yields an upper twin.
    assert any(r["raw"] != r["raw"].lower() for r in other_rows)


def test_empty_exclusion_list_changes_nothing(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path)
    baseline = [(r["source"], r["raw"]) for r in _emit(corpus)]
    explicit = [(r["source"], r["raw"]) for r in _emit(corpus, augment_exclude_sources=[])]
    assert baseline == explicit


def test_strict_config_declares_the_field() -> None:
    from mailwoman_train.config import DataConfig

    assert DataConfig().augment_exclude_sources == []
