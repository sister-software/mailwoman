"""The output-directory lock that refuses a second launch onto a run another call is still training.

A training call writes `LAUNCH_LOCK.json` beside its checkpoint directory, recording its function call id. The file
sits in the run base, and `--fresh` clears only the checkpoint directory. Every attempt of that call re-enters the lock, because a retry keeps the call
id. Another call refuses to start while the call the lock names is still running, and takes the lock over once that
call has finished or failed. A `--fresh` preflight refuses to clear an output directory whose lock holder is running.

The lock is advisory and is checked, then written, without an atomic compare: two launches that start within the
seconds between one's check and its volume commit can both pass. It is for the duplicate a person makes by relaunching
a run that is still going.

This module imports neither `modal` nor the training package. The caller passes the probe that asks Modal whether a
call is running, so the decisions are tested locally.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

#: The lock file's name in a run's base directory.
LOCK_NAME = "LAUNCH_LOCK.json"


class DuplicateLaunchError(RuntimeError):
    """Another call that is still running holds the run's lock."""


@dataclass(frozen=True)
class LockDecision:
    """What a call does with a run's lock: ``acquire`` an absent one, ``reenter`` its own, or ``take_over`` a stale one."""

    action: str
    previous_holder: str | None


def decide(existing: dict[str, object] | None, call_id: str, is_running: Callable[[str], bool]) -> LockDecision:
    """The decision for ``call_id`` given the lock on the volume, or ``DuplicateLaunchError`` when it must refuse."""
    if existing is None:
        return LockDecision("acquire", None)
    holder = existing.get("function_call_id")
    if not isinstance(holder, str) or not holder:
        raise ValueError(f"{LOCK_NAME} names no function_call_id: {existing!r}")
    if holder == call_id:
        return LockDecision("reenter", holder)
    if is_running(holder):
        raise DuplicateLaunchError(
            f"the run is held by function call {holder}, which is still running; cancel it "
            f"(python -m launch.call_status {holder} --cancel) or wait for it before launching again"
        )
    return LockDecision("take_over", holder)


def read_lock(run_base: Path) -> dict[str, object] | None:
    """The lock in ``run_base``, or ``None`` when there is none. A lock that is not a JSON object raises."""
    path = run_base / LOCK_NAME
    if not path.is_file():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def acquire(run_base: Path, call_id: str, config_sha256: str, is_running: Callable[[str], bool]) -> LockDecision:
    """Decide, and write the lock unless this call already holds it. The caller commits the volume."""
    decision = decide(read_lock(run_base), call_id, is_running)
    if decision.action != "reenter":
        run_base.mkdir(parents=True, exist_ok=True)
        record = {
            "function_call_id": call_id,
            "config_sha256": config_sha256,
            "acquired_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "previous_holder": decision.previous_holder,
        }
        (run_base / LOCK_NAME).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return decision


def refuse_if_held(run_base: Path, is_running: Callable[[str], bool]) -> None:
    """Raise ``DuplicateLaunchError`` when a running call holds the lock in ``run_base``; the `--fresh` check."""
    existing = read_lock(run_base)
    if existing is not None:
        decide(existing, "", is_running)
