"""P0 sampler stationarity (2026-08-09 training-substrate audit, HANDOFF-CODEX-TO-CLAUDE §6).

``_raw_row_stream`` samples sources by weighted multinomial, but when a source's finite
iterator exhausts it DELETES the source and renormalizes the remaining mixture. So
``source_weights`` is only the OPENING distribution: a small oversampled source (the #1569
30k-row suffix slice at weight 12.0) is live for the first ~3,330 optimizer steps of each
~7,812-step epoch and silent afterwards. The v4.3.3 B1 board oscillated in lockstep with
those exposure windows.

Contract pinned here (the repair): the realized source mixture must be STATIONARY across
the whole epoch. A source that exhausts before the epoch ends cycles (fresh shuffled pass —
weighted sampling with replacement at the pass level); the epoch ends once every source has
completed at least one full pass, so the largest source is seen exactly once and no source
ever silently leaves the mixture.
"""

from __future__ import annotations

import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

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


def _rows(source: str, n: int, country: str = "US") -> list[dict]:
    return [
        {
            "raw": f"{i} Main St {source}",
            "tokens": [str(i), "Main", "St", source],
            "labels": ["O", "O", "O", "O"],
            "country": country,
            "source": source,
        }
        for i in range(n)
    ]


def _write_corpus(tmp_path: Path, slices: dict[str, list[dict]]) -> Path:
    corpus = tmp_path / "corpus"
    (corpus / "train").mkdir(parents=True)
    for name, rows in slices.items():
        table = pa.Table.from_pylist(rows, schema=LEGACY_SCHEMA)
        pq.write_table(table, corpus / "train" / name)
    return corpus


def _emit(corpus: Path, source_weights: dict[str, float]) -> list[dict]:
    return list(
        iter_rows(
            corpus,
            "train",
            rng=random.Random(0),
            country_weights={"US": 1.0},
            source_weights=source_weights,
            coarse_filter=False,
            shuffle_buffer=1,
        )
    )


def test_small_source_keeps_appearing_after_its_first_pass_exhausts(tmp_path: Path) -> None:
    """The exposure-window defect head-on: at equal weights, the 12-row source exhausts ~24
    draws into a 132-row epoch and today contributes NOTHING to the remaining ~110 draws.
    A stationary mixture keeps it present in every quarter of the stream."""
    corpus = _write_corpus(
        tmp_path,
        {"part-big.parquet": _rows("big", 120), "part-small.parquet": _rows("small", 12)},
    )
    emitted = [r["source"] for r in _emit(corpus, {"big": 1.0, "small": 1.0})]
    q = len(emitted) // 4
    for i in range(4):
        quarter = emitted[i * q : (i + 1) * q]
        assert "small" in quarter, (
            f"quarter {i + 1}/4 contains no 'small' draws — the source left the mixture "
            f"after its first pass (non-stationary sampling)"
        )


def test_epoch_covers_the_large_source_once_and_cycles_the_small_one(tmp_path: Path) -> None:
    """Epoch semantics under the stationary contract: the largest source completes exactly
    one full pass (every row exactly once, no loss, no duplication); the small source cycles
    to hold its weighted share, so it emits MORE rows than it contains."""
    big_rows = _rows("big", 120)
    small_rows = _rows("small", 12)
    corpus = _write_corpus(tmp_path, {"part-big.parquet": big_rows, "part-small.parquet": small_rows})
    emitted = _emit(corpus, {"big": 1.0, "small": 1.0})

    big_emitted = [r["raw"] for r in emitted if r["source"] == "big"]
    small_emitted = [r["raw"] for r in emitted if r["source"] == "small"]

    assert sorted(big_emitted) == sorted(r["raw"] for r in big_rows)
    assert len(small_emitted) > len(small_rows), (
        "small source emitted at most one pass — cycling (weight-holding oversample) is not happening"
    )
    assert set(small_emitted) == {r["raw"] for r in small_rows}


def test_realized_share_is_stable_between_stream_halves(tmp_path: Path) -> None:
    """Quantified stationarity: at weights 1:1 the small source's realized share must sit
    near 0.5 in BOTH halves of the stream, not ~1.0-then-0.0."""
    corpus = _write_corpus(
        tmp_path,
        {"part-big.parquet": _rows("big", 120), "part-small.parquet": _rows("small", 12)},
    )
    emitted = [r["source"] for r in _emit(corpus, {"big": 1.0, "small": 1.0})]
    half = len(emitted) // 2
    for name, part in (("first", emitted[:half]), ("second", emitted[half:])):
        share = sum(1 for s in part if s == "small") / len(part)
        assert 0.3 < share < 0.7, f"{name} half: small share {share:.2f} — mixture drifted from its 0.5 weight"


def test_positive_weight_source_with_zero_selectable_rows_raises(tmp_path: Path) -> None:
    """A cycling sampler must never spin on a source whose filters admit nothing. A source
    whose full pass yields ZERO selectable rows (here: every row filtered by country) is a
    recipe/corpus contract violation — fail loudly naming the source, never silently drop it
    (the same discipline as the unreachable-positive-weight guard)."""
    corpus = _write_corpus(
        tmp_path,
        {
            "part-big.parquet": _rows("big", 24),
            "part-empty.parquet": _rows("empty", 6, country="FR"),
        },
    )
    with pytest.raises(ValueError, match="empty"):
        _emit(corpus, {"big": 1.0, "empty": 1.0})


def test_source_absent_from_source_weights_raises(tmp_path: Path) -> None:
    """The mirror of the guard above, and the one that was missing. A positive weight with no slice
    raises; a slice with no weight used to be filtered out and logged at INFO as "zero-weighted",
    which is what a DELIBERATE zero also says. The shape it hid: a regenerated slice takes a version
    suffix in its ``source`` column, the config keeps the old key, and training continues on the
    superseded vintage."""
    corpus = _write_corpus(
        tmp_path,
        {
            "part-old.parquet": _rows("synth-fr-bare-street", 12),
            "part-new.parquet": _rows("synth-fr-bare-street-v22", 24),
        },
    )
    with pytest.raises(ValueError, match="synth-fr-bare-street-v22"):
        _emit(corpus, {"synth-fr-bare-street": 12.0})


def test_source_named_at_zero_is_declined_without_raising(tmp_path: Path) -> None:
    """Naming a source at zero is how the config declines it, so that path stays silent and legal —
    the refusal above must not make ``synth-no-street-led: 0.0`` unexpressible."""
    corpus = _write_corpus(
        tmp_path,
        {
            "part-big.parquet": _rows("big", 24),
            "part-off.parquet": _rows("off", 6),
        },
    )
    emitted = _emit(corpus, {"big": 1.0, "off": 0.0})

    assert {row["source"] for row in emitted} == {"big"}


def test_val_split_still_tolerates_an_unnamed_source(tmp_path: Path) -> None:
    """Validation corpora carry their own fixed source subset, so the refusal is scoped to the split
    whose recipe claims coverage — the same scoping the unreachable-positive-weight guard already
    uses."""
    corpus = tmp_path / "corpus"
    (corpus / "val").mkdir(parents=True)
    pq.write_table(
        pa.Table.from_pylist(_rows("held-out", 8), schema=LEGACY_SCHEMA),
        corpus / "val" / "part-val.parquet",
    )

    emitted = list(
        iter_rows(
            corpus,
            "val",
            rng=random.Random(0),
            country_weights={"US": 1.0},
            source_weights={"something-else": 1.0},
            coarse_filter=False,
            shuffle_buffer=1,
        )
    )

    assert len(emitted) == 8
