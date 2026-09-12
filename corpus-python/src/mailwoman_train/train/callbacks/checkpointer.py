"""Periodic checkpoint writes.

Only the interval saves live here. The run's FINAL checkpoint stays in the loop, because its path
is what the Fisher artifact is written beside — a product of the run rather than an observation of
it, and the loop is what can still fail loudly if it does not land.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from ...config import Config
from ..checkpoint import save_checkpoint
from ..state import TrainState


def checkpoint_extras(state: TrainState, step: int) -> dict[str, Any]:
    """The config stamped into a checkpoint, which the resume-drift audit reads back."""
    return {
        "step": step,
        "config": {
            "data": asdict(state.cfg.data),
            "model": asdict(state.cfg.model),
            "train": asdict(state.cfg.train),
        },
        "vocab_size": state.vocab_size,
    }


class CheckpointerCallback:
    """Saves every `save_every_steps` optimizer steps."""

    def __init__(self, cfg: Config) -> None:
        self._save_every = max(1, cfg.train.save_every_steps)

    def on_train_begin(self, state: TrainState) -> None:
        pass

    def on_step_end(self, state: TrainState, step: int) -> None:
        if step % self._save_every:
            return
        saved = save_checkpoint(
            state.model,
            state.output_dir,
            step,
            checkpoint_extras(state, step),
            optim=state.optimizer,
            scheduler=state.scheduler,
        )
        print(f"  [save] checkpoint → {saved}")

    def on_eval_end(self, state: TrainState, step: int, metrics: dict[str, float]) -> None:
        pass

    def on_train_end(self, state: TrainState) -> None:
        pass
