"""Checks the output-directory lock's decisions: acquire, re-enter on a retry, take over a stale lock, refuse a live one."""

from __future__ import annotations

from pathlib import Path

import pytest
from launch.run_lock import LOCK_NAME, DuplicateLaunchError, acquire, decide, read_lock, refuse_if_held


def _running(*ids: str):
    return lambda call_id: call_id in ids


def test_a_run_without_a_lock_is_acquired_and_recorded(tmp_path: Path) -> None:
    decision = acquire(tmp_path / "run", "fc-a", "abc", _running())
    assert decision.action == "acquire"
    lock = read_lock(tmp_path / "run")
    assert lock is not None
    assert lock["function_call_id"] == "fc-a"
    assert lock["config_sha256"] == "abc"


def test_a_retry_of_the_same_call_reenters_its_lock(tmp_path: Path) -> None:
    acquire(tmp_path, "fc-a", "abc", _running())
    before = (tmp_path / LOCK_NAME).read_text()
    assert acquire(tmp_path, "fc-a", "abc", _running("fc-a")).action == "reenter"
    assert (tmp_path / LOCK_NAME).read_text() == before


def test_a_second_call_is_refused_while_the_holder_runs(tmp_path: Path) -> None:
    acquire(tmp_path, "fc-a", "abc", _running())
    with pytest.raises(DuplicateLaunchError, match="fc-a"):
        acquire(tmp_path, "fc-b", "abc", _running("fc-a"))
    lock = read_lock(tmp_path)
    assert lock is not None and lock["function_call_id"] == "fc-a"


def test_a_finished_holder_is_taken_over(tmp_path: Path) -> None:
    acquire(tmp_path, "fc-a", "abc", _running())
    decision = acquire(tmp_path, "fc-b", "abc", _running())
    assert decision.action == "take_over"
    assert decision.previous_holder == "fc-a"
    lock = read_lock(tmp_path)
    assert lock is not None and lock["previous_holder"] == "fc-a"


def test_a_fresh_start_is_refused_under_a_running_holder(tmp_path: Path) -> None:
    refuse_if_held(tmp_path, _running("fc-a"))
    acquire(tmp_path, "fc-a", "abc", _running())
    with pytest.raises(DuplicateLaunchError):
        refuse_if_held(tmp_path, _running("fc-a"))
    refuse_if_held(tmp_path, _running())


def test_a_lock_that_names_no_call_raises() -> None:
    with pytest.raises(ValueError, match="function_call_id"):
        decide({"config_sha256": "abc"}, "fc-a", _running())
