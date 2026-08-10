"""Full-epoch mixture audit (HANDOFF-CODEX-TO-CLAUDE §6 action 7).

The 250k-row prefix audits ended before any source exhausted, so they could not see the
non-stationary sampler. ``audit_epoch_mixture.audit_mixture`` consumes a full row-limited
epoch and reports requested vs realized source/country mix at two levels: raw DRAWS (the
sampler's stationarity receipt) and EMITTED rows under the train augmentation policy (the
unit the model reads — augmentable sources claim extra share of a row_limit).
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from mailwoman_train.audit_epoch_mixture import audit_mixture

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
            "raw": f"{i} Main Rd {source}",
            "tokens": [str(i), "Main", "Rd", source],
            "labels": ["O", "O", "O", "O"],
            "country": "US",
            "source": source,
        }
        for i in range(n)
    ]


def _write_corpus(tmp_path: Path) -> Path:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    for name, rows in (("part-big.parquet", _rows("big", 300)), ("part-small.parquet", _rows("small", 30))):
        pq.write_table(pa.Table.from_pylist(rows, schema=LEGACY_SCHEMA), corpus / "train" / name)
    return corpus


def _audit(corpus: Path, **overrides) -> dict:
    kwargs = {
        "seed": 43,
        "draws": 400,
        "window": 100,
        "country_weights": {"US": 1.0},
        "source_weights": {"big": 1.0, "small": 1.0},
        "coarse_filter": False,
    }
    kwargs.update(overrides)
    return audit_mixture(corpus, **kwargs)


def test_draw_level_windows_show_a_stationary_mixture(tmp_path: Path) -> None:
    report = _audit(_write_corpus(tmp_path))

    windows = report["draw_level"]["windows"]
    assert len(windows) == 4
    for w in windows:
        assert sum(w.values()) == 100
        assert set(w) == {"big", "small"}, f"a source left the mixture mid-epoch: {dict(w)}"

    totals = report["draw_level"]["totals"]
    assert sum(totals.values()) == 400
    assert report["requested"]["small"] == 0.5
    small_share = totals["small"] / 400
    assert 0.35 < small_share < 0.65

    per_source = report["draw_level"]["per_source"]
    assert set(per_source) == {"big", "small"}
    for src in ("big", "small"):
        assert 0.0 <= per_source[src]["max_window_relative_deviation"] < 0.5


def test_emitted_level_equals_draw_level_when_augmentation_is_off(tmp_path: Path) -> None:
    """With every augmentation at 0 and no relabel lexicon, both passes consume the rng
    identically, so the emitted counts are byte-equal to the draw counts."""
    report = _audit(_write_corpus(tmp_path))

    assert report["emitted_level"]["totals"] == report["draw_level"]["totals"]
    for src, stats in report["emitted_level"]["per_source"].items():
        assert stats["distortion_vs_draw_share"] == 1.0, (src, stats)


def test_emitted_level_counts_augmented_copies_against_the_row_budget(tmp_path: Path) -> None:
    """Augmented copies (original + upper-cased twin at prob 1.0) fill the same row_limit
    budget, so emitted totals still sum to ``draws`` and upper-cased twins are present —
    the distortion the quota design must account for."""
    report = _audit(_write_corpus(tmp_path), augment={"upper_case": 1.0})

    totals = report["emitted_level"]["totals"]
    assert sum(totals.values()) == 400
    assert report["emitted_level"]["augmented_share"] > 0.3


def _seeded_control_shares(corpus: Path) -> tuple[float, float]:
    """Two independent seeds' small-source shares, for the determinism check below."""
    a = audit_mixture(
        corpus,
        seed=1,
        draws=200,
        window=100,
        country_weights={"US": 1.0},
        source_weights={"big": 1.0, "small": 1.0},
        coarse_filter=False,
    )
    b = audit_mixture(
        corpus,
        seed=1,
        draws=200,
        window=100,
        country_weights={"US": 1.0},
        source_weights={"big": 1.0, "small": 1.0},
        coarse_filter=False,
    )
    return (
        a["draw_level"]["totals"]["small"] / 200,
        b["draw_level"]["totals"]["small"] / 200,
    )


def test_audit_is_deterministic_for_a_fixed_seed(tmp_path: Path) -> None:
    corpus = _write_corpus(tmp_path)
    share_a, share_b = _seeded_control_shares(corpus)
    assert share_a == share_b
    assert random.Random(1).random() == random.Random(1).random()  # sanity on the invariant used
