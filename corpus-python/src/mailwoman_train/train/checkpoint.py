"""Writing a resumable checkpoint, and finding the last complete one.

The write is atomic and the discovery trusts one marker, which are two halves of the same
guarantee: an interrupted save must leave either the previous complete checkpoint or nothing, never
a partial directory that `--resume auto` would load and train from.

What resumes exactly: model, optimizer, scheduler, step, RNG. What does not: the data stream. The
sampler position is not saved, so a resumed run continues optimizer state over a re-sampled stream
rather than the identical row sequence.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, cast

import torch


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
    ck = output_dir / f"step-{step:06d}"
    tmp = output_dir / f".tmp-step-{step:06d}"
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
        # Written LAST: its presence is the completeness marker find_latest_checkpoint trusts.
        (tmp / "training_state.json").write_text(json.dumps(extras, indent=2) + "\n", encoding="utf-8")
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    if ck.exists():
        shutil.rmtree(ck)
    tmp.rename(ck)
    return ck


def find_latest_checkpoint(output_dir: Path) -> Path | None:
    """The highest-step COMPLETE ``step-XXXXXX`` directory under ``output_dir``.

    Complete means it carries ``training_state.json``. A directory left by an interrupted
    pre-atomic save lacks it and is skipped rather than resumed.
    """
    if not output_dir.is_dir():
        return None
    candidates = sorted(p for p in output_dir.glob("step-*") if (p / "training_state.json").is_file())
    return candidates[-1] if candidates else None
