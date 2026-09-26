"""Writing a resumable checkpoint, and finding the last complete one.

The write is atomic: an interrupted save leaves either the previous complete checkpoint or no
directory `--resume auto` would load. Model, optimizer, scheduler, step and RNG resume; the data
stream does not, because the sampler position is not saved.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, cast

import torch

CHECKPOINT_STEP_DIGITS = 6


def checkpoint_dir_name(step: int | str) -> str:
    """The directory name a checkpoint at ``step`` is written under: ``step-000500``, ``step-060000``.

    Takes either an int or a string because a step reaches a Modal entry point as a string.
    """
    return f"step-{int(step):0{CHECKPOINT_STEP_DIGITS}d}"


def save_checkpoint(
    model: torch.nn.Module,
    output_dir: Path,
    step: int,
    extras: dict[str, Any],
    *,
    optim: torch.optim.Optimizer | None = None,
    scheduler: Any = None,
    rng_state: dict[str, Any] | None = None,
) -> Path:
    """Save model, optimizer, scheduler and RNG state into ``output_dir/step-XXXXXX/``.

    Everything is written into a temp directory the ``step-*`` discovery glob cannot see,
    ``training_state.json`` last, then renamed into place.
    """
    ck = output_dir / checkpoint_dir_name(step)
    tmp = output_dir / f".tmp-{checkpoint_dir_name(step)}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    try:
        if hasattr(model, "save_pretrained"):
            cast(Any, model).save_pretrained(tmp)
        else:
            torch.save(model.state_dict(), tmp / "pytorch_model.bin")
        if optim is not None:
            torch.save(optim.state_dict(), tmp / "optimizer.pt")
        if scheduler is not None:
            torch.save(scheduler.state_dict(), tmp / "scheduler.pt")
        if rng_state is not None:
            torch.save(rng_state, tmp / "rng_state.pt")
        (tmp / "training_state.json").write_text(json.dumps(extras, indent=2) + "\n", encoding="utf-8")
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    if ck.exists():
        shutil.rmtree(ck)
    tmp.rename(ck)
    return ck


def find_latest_checkpoint(output_dir: Path) -> Path | None:
    """The highest-step COMPLETE ``step-XXXXXX`` directory under ``output_dir``, complete meaning it carries ``training_state.json``."""
    if not output_dir.is_dir():
        return None
    candidates = sorted(p for p in output_dir.glob("step-*") if (p / "training_state.json").is_file())
    return candidates[-1] if candidates else None
