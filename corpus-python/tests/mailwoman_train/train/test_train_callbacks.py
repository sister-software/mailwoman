"""A callback observes the loop without steering it."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from mailwoman_train import protocols
from mailwoman_train.train import callbacks
from mailwoman_train.train.trainer import train

from .test_train_loop_trace import MAX_STEPS, _probe_config


class _Recorder:
    """A plain class, inheriting nothing, that the protocol should still accept."""

    def __init__(self) -> None:
        self.events: list[str] = []

    def on_train_begin(self, state: Any) -> None:
        self.events.append("begin")

    def on_step_end(self, state: Any, step: int) -> None:
        self.events.append(f"step:{step}")

    def on_eval_end(self, state: Any, step: int, metrics: dict[str, float]) -> None:
        self.events.append(f"eval:{step}")

    def on_train_end(self, state: Any) -> None:
        self.events.append("end")


class _Exploder(_Recorder):
    def on_step_end(self, state: Any, step: int) -> None:
        raise RuntimeError("a callback that must stop the run raises")


def test_a_plain_class_satisfies_the_protocol_without_inheriting() -> None:
    assert isinstance(_Recorder(), protocols.TrainCallback)


def test_every_shipped_callback_satisfies_the_protocol() -> None:
    from mailwoman_train.config import load_config

    from .test_train_loop_trace import PROBE_2K

    cfg = load_config(PROBE_2K)
    for callback in callbacks.default_callbacks(cfg):
        assert isinstance(callback, protocols.TrainCallback), type(callback).__name__


def test_the_default_list_is_the_order_the_log_is_composed_in() -> None:
    from mailwoman_train.config import load_config

    from .test_train_loop_trace import PROBE_2K

    names = [type(c).__name__ for c in callbacks.default_callbacks(load_config(PROBE_2K))]
    assert names == ["ConsoleCallback", "CSVMetricsCallback", "TrackioCallback", "CheckpointerCallback"]


def test_a_supplied_list_replaces_the_defaults(tmp_path: Path) -> None:
    """With one recorder and nothing else, the run writes no CSV and prints no progress line."""
    cfg = _probe_config(tmp_path)
    recorder = _Recorder()
    train(cfg, callbacks=[recorder])

    assert recorder.events[0] == "begin"
    assert recorder.events[-1] == "end"
    assert [e for e in recorder.events if e.startswith("step:")] == [f"step:{n}" for n in range(1, MAX_STEPS + 1)]
    assert [e for e in recorder.events if e.startswith("eval:")] == ["eval:2", "eval:4"]

    from mailwoman_train.config import csv_log_path

    assert not csv_log_path(cfg).exists(), "the CSV callback was not in the list, so no CSV should exist"


def test_a_raising_callback_stops_the_run_and_still_closes_the_others(tmp_path: Path) -> None:
    """The loop reads no return value, so raising is a callback's only way to stop a run.

    `on_train_end` must still reach the other callbacks — a crashed run's partial CSV is worth
    more than a clean unwind.
    """
    cfg = _probe_config(tmp_path)
    recorder = _Recorder()
    with pytest.raises(RuntimeError, match="must stop the run"):
        train(cfg, callbacks=[_Exploder(), recorder])

    assert recorder.events == ["begin", "end"]
