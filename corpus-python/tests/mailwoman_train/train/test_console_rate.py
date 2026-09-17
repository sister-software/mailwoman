"""The `rate=` figure on the console step line, which reports throughput for this process.

A resumed run inherits the step counter but not the seconds. Dividing the absolute step by time-since-start reported
103.70 steps/s on a run resumed at 35,000 whose real rate was 5.42, and the figure fell every line as `elapsed` grew
rather than settling — the shape of a ratio whose numerator is inherited.
"""

from __future__ import annotations

import contextlib
import io
from typing import Any

from mailwoman_train.train.callbacks.console import ConsoleCallback


class _Config:
    def __init__(self, log_every_steps: int = 100, max_steps: int = 60000) -> None:
        self.train = type("T", (), {"log_every_steps": log_every_steps, "max_steps": max_steps})()


class _State:
    def __init__(self, *, start_step: int, elapsed: float) -> None:
        self.start_step = start_step
        self.elapsed = elapsed
        self.train_loss = 0.6195
        self.learning_rate = 0.000166


def _line(state: Any, step: int) -> str:
    out = io.StringIO()

    with contextlib.redirect_stdout(out):
        ConsoleCallback(_Config()).on_step_end(state, step)

    return out.getvalue().strip()


def test_a_fresh_run_reports_step_over_elapsed() -> None:
    # start_step 0 means the two definitions agree, so this pins that the change moves no fresh-run number.
    assert "rate=5.00 steps/s" in _line(_State(start_step=0, elapsed=200.0), 1000)


def test_a_fresh_run_names_no_span() -> None:
    # There is no previous process to distinguish it from.
    assert "over" not in _line(_State(start_step=0, elapsed=200.0), 1000)


def test_a_resumed_run_reports_only_the_steps_it_ran() -> None:
    # The reported case: resumed at 35,000, 2,100 steps later, 387.5 s of this process.
    line = _line(_State(start_step=35000, elapsed=387.5), 37100)

    assert "rate=5.42 steps/s" in line


def test_a_resumed_run_names_the_span_the_figure_covers() -> None:
    line = _line(_State(start_step=35000, elapsed=387.5), 37100)

    assert "over 2,100 since step 35,000" in line


def test_the_absolute_ratio_is_not_what_is_printed() -> None:
    # 37,100 / 387.5 = 95.74, the figure this replaces.
    assert "95.74" not in _line(_State(start_step=35000, elapsed=387.5), 37100)


def test_a_zero_clock_reports_zero_rather_than_dividing() -> None:
    # The first line of a run can land before the clock advances.
    assert "rate=0.00 steps/s" in _line(_State(start_step=0, elapsed=0.0), 100)
