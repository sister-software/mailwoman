"""A pre-training checkpoint without `scheduler.pt` REPLAYS its schedule rather than starting over.

`scheduler.pt` postdates the first MLM checkpoints, so a resume can find the step and no schedule
state. Left at step 0 the schedule restarts inside warmup, at a learning rate the earlier steps had
already passed — the run trains, writes checkpoints and logs a plausible loss curve, and does not
continue the run it says it continues.

Nothing exercised this. `pretrain()` needs a real SentencePiece model and a corpus to run at all,
so its resume path was reachable only from a training run. `restore_pretrain_state` is the part
that decides the resumed step, and it needs neither.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import torch
from torch.optim import AdamW

from mailwoman_train.optim.schedules import build_scheduler
from mailwoman_train.train.pretrain import restore_pretrain_state

RESUME_STEP = 37


class _TrainSettings:
    """The schedule fields `build_scheduler` reads, with warmup long enough to still be inside it."""

    learning_rate = 1e-3
    weight_decay = 0.01
    warmup_steps = 100
    max_steps = 1000
    lr_schedule = "cosine"
    min_lr_ratio = 0.0


def _optimizer_and_scheduler() -> tuple[AdamW, Any]:
    optim = AdamW([torch.nn.Parameter(torch.zeros(2))], lr=_TrainSettings.learning_rate)
    return optim, build_scheduler(optim, _TrainSettings())


def _write_checkpoint(directory: Path, *, with_scheduler: bool) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "training_state.json").write_text(json.dumps({"step": RESUME_STEP}))
    optim, scheduler = _optimizer_and_scheduler()
    for _ in range(RESUME_STEP):
        optim.step()
        scheduler.step()
    torch.save(optim.state_dict(), directory / "optimizer.pt")
    if with_scheduler:
        torch.save(scheduler.state_dict(), directory / "scheduler.pt")
    return directory


def _rate_after(steps: int) -> float:
    """The learning rate a fresh schedule reaches after `steps`, read independently of the resume."""
    _, scheduler = _optimizer_and_scheduler()
    for _ in range(steps):
        scheduler.step()
    return float(scheduler.get_last_lr()[0])


def test_a_checkpoint_without_scheduler_state_replays_the_schedule(tmp_path: Path) -> None:
    checkpoint = _write_checkpoint(tmp_path / "step-37-legacy", with_scheduler=False)
    optim, scheduler = _optimizer_and_scheduler()

    assert restore_pretrain_state(optim, scheduler, checkpoint) == RESUME_STEP
    assert float(scheduler.get_last_lr()[0]) == _rate_after(RESUME_STEP)
    assert float(scheduler.get_last_lr()[0]) != _rate_after(0), "the fixture is not inside warmup"


def test_a_checkpoint_with_scheduler_state_loads_it(tmp_path: Path) -> None:
    checkpoint = _write_checkpoint(tmp_path / "step-37", with_scheduler=True)
    optim, scheduler = _optimizer_and_scheduler()

    assert restore_pretrain_state(optim, scheduler, checkpoint) == RESUME_STEP
    assert float(scheduler.get_last_lr()[0]) == _rate_after(RESUME_STEP)


def test_an_empty_checkpoint_directory_resumes_at_step_zero(tmp_path: Path) -> None:
    """A directory with nothing in it is a resume that has nothing to restore, not a failure."""
    empty = tmp_path / "empty"
    empty.mkdir()
    optim, scheduler = _optimizer_and_scheduler()

    assert restore_pretrain_state(optim, scheduler, empty) == 0
    assert float(scheduler.get_last_lr()[0]) == _rate_after(0)
