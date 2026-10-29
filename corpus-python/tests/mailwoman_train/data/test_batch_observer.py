"""The batch observer sees a batch's rows only after the consumer has asked for the next batch.

`iter_batches` hands each batch of sampled rows to the row encoder. These tests replace the sampler with a fixed row
list and the encoder with one that records the rows it was given, so the order of encoder calls, yielded batches and
observer events can be asserted together, along with the row-limit, final partial batch, epoch restart and resume
behavior the training loop relies on.
"""

from __future__ import annotations

import itertools
import random
from types import SimpleNamespace
from typing import Any
from unittest import mock

import numpy as np
import pytest

from mailwoman_train.data.loader import batch as batch_module
from mailwoman_train.labels import locale_id

ROWS = [{"raw": f"{i} Main St", "country": "US"} for i in range(5)]

Events = list[tuple[str, list[str]]]


class RecordingEncoder:
    """Encodes each row as its leading number and records every batch it was asked to encode."""

    def __init__(self, events: Events) -> None:
        self.events = events

    def encode_batch(self, rows: list[dict[str, Any]]) -> dict[str, np.ndarray]:
        self.events.append(("encode", [row["raw"] for row in rows]))
        ids = np.array([[int(row["raw"].split()[0])] for row in rows], dtype=np.int64)
        return {"input_ids": ids, "attention_mask": np.ones_like(ids), "labels": np.zeros_like(ids)}


def sampled(rows: list[dict[str, Any]]) -> Any:
    """A stand-in for `iter_sampled_rows` that honors the row limit."""

    def fake(_cfg: Any, _split: str, *, rng: random.Random, row_limit: int | None = None, observer: Any = None) -> Any:
        for i, row in enumerate(rows):
            if row_limit is not None and i >= row_limit:
                return
            yield row

    return fake


def config() -> Any:
    return SimpleNamespace(data=SimpleNamespace(char_mode="off", label_set="stage3"))


def run(events: Events, *, batch_size: int, row_limit: int | None = None, seed: int = 0) -> Any:
    return batch_module.iter_batches(
        config(),
        RecordingEncoder(events),  # type: ignore[arg-type]
        split="train",
        batch_size=batch_size,
        seed=seed,
        row_limit=row_limit,
        observer=lambda row: events.append(("observe", [row["raw"]])),
    )


def ids(batch: dict[str, Any]) -> list[int]:
    return [int(v) for v in batch["input_ids"][:, 0]]


def observed(events: Events) -> list[str]:
    return [e[1][0] for e in events if e[0] == "observe"]


def test_an_abandoned_batch_is_never_observed() -> None:
    events: Events = []
    with mock.patch.object(batch_module, "iter_sampled_rows", sampled(ROWS)):
        stream = run(events, batch_size=2)
        assert ids(next(stream)) == [0, 1]
        assert events == [("encode", ["0 Main St", "1 Main St"])]
        assert ids(next(stream)) == [2, 3]
        assert events[1:] == [
            ("observe", ["0 Main St"]),
            ("observe", ["1 Main St"]),
            ("encode", ["2 Main St", "3 Main St"]),
        ]
        stream.close()  # The loop breaks at max_steps with [2, 3] fetched and untrained.
    assert observed(events) == ["0 Main St", "1 Main St"]


def test_the_final_partial_batch_is_yielded_and_observed_once_the_stream_ends() -> None:
    events: Events = []
    with mock.patch.object(batch_module, "iter_sampled_rows", sampled(ROWS)):
        assert [ids(b) for b in run(events, batch_size=2)] == [[0, 1], [2, 3], [4]]
    assert observed(events) == [row["raw"] for row in ROWS]
    assert events[-2:] == [("encode", ["4 Main St"]), ("observe", ["4 Main St"])]


def test_the_row_limit_bounds_the_rows_encoded() -> None:
    events: Events = []
    with mock.patch.object(batch_module, "iter_sampled_rows", sampled(ROWS)):
        assert [ids(b) for b in run(events, batch_size=2, row_limit=3)] == [[0, 1], [2]]
    assert sum(len(e[1]) for e in events if e[0] == "encode") == 3


def test_locale_ids_follow_row_order() -> None:
    rows = [{"raw": "1 rue de Rivoli", "country": "FR"}, {"raw": "2 Main St", "country": "US"}]
    with mock.patch.object(batch_module, "iter_sampled_rows", sampled(rows)):
        batch = next(run([], batch_size=2))
    assert batch["locale_ids"] == [locale_id("FR"), locale_id("US")]
    assert len(batch["address_system_ids"]) == 2


def seeded(_cfg: Any, _split: str, *, rng: random.Random, row_limit: int | None = None, observer: Any = None) -> Any:
    """A stand-in for `iter_sampled_rows` whose row order depends on the generator it is given."""
    order = list(range(len(ROWS)))
    rng.shuffle(order)
    for i in order:
        yield ROWS[i]


def training_stream(events: Events, *, skip_batches: int, batch_size: int = 2) -> Any:
    return batch_module.iter_training_batches(
        config(),
        RecordingEncoder(events),  # type: ignore[arg-type]
        batch_size=batch_size,
        seed=42,
        skip_batches=skip_batches,
        observer=lambda row: events.append(("observe", [row["raw"]])),
    )


def test_each_epoch_reopens_the_stream_with_seed_plus_epoch() -> None:
    with mock.patch.object(batch_module, "iter_sampled_rows", seeded):
        stream = training_stream([], skip_batches=0, batch_size=len(ROWS))
        first, second = ids(next(stream)), ids(next(stream))
        assert first == ids(next(run([], batch_size=len(ROWS), seed=43)))
        assert second == ids(next(run([], batch_size=len(ROWS), seed=44)))
    assert first != second
    assert sorted(first) == sorted(second) == list(range(len(ROWS)))


def test_a_resumed_stream_continues_with_the_batch_an_uninterrupted_stream_reads_next() -> None:
    """Five rows in batches of two make three batches per epoch, so the skips cross epoch boundaries."""
    with mock.patch.object(batch_module, "iter_sampled_rows", seeded):
        uninterrupted = [ids(b) for b in itertools.islice(training_stream([], skip_batches=0), 14)]
        for consumed in range(8):
            resumed = [ids(b) for b in itertools.islice(training_stream([], skip_batches=consumed), 6)]
            assert resumed == uninterrupted[consumed : consumed + 6], consumed


def test_skipped_batches_are_neither_encoded_nor_observed() -> None:
    events: Events = []
    with mock.patch.object(batch_module, "iter_sampled_rows", sampled(ROWS)):
        stream = training_stream(events, skip_batches=2)
        assert ids(next(stream)) == [4]
        assert events == [("encode", ["4 Main St"])]


def test_a_train_split_without_rows_raises_rather_than_looping() -> None:
    with mock.patch.object(batch_module, "iter_sampled_rows", sampled([])):
        stream = training_stream([], skip_batches=0)
        with pytest.raises(ValueError, match="yielded no rows in epoch 1"):
            next(stream)
