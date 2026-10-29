"""The validation draw a run evaluates on, encoded once and replayed at every evaluation.

Every evaluation reads the same rows: `iter_batches` over the `val` split with the fixed seed `cfg.train.seed + 1`
and the fixed `row_limit`, and every random choice in the data path draws from the generator that seed creates. On a
corpus whose validation rows sit inside the training files, finding those rows walks most of the corpus, which made
each evaluation of a 90,000-step run take about six minutes. Encoding them once, as CPU tensors, keeps every later
evaluation to the model's forward passes.
"""

from __future__ import annotations

from typing import Any

import mailwoman_mtf
import torch

from ..config import Config
from ..data.loader import iter_batches
from .batch import to_tensor_batch

#: The CPU device the cached batches live on between evaluations.
_CPU = torch.device("cpu")


def validation_batches(
    cfg: Config, encoder: mailwoman_mtf.RowEncoder | None, max_rows: int | None
) -> list[dict[str, Any]]:
    """Encode the run's validation draw into CPU tensor batches, in the order the loader yields them."""
    return [
        to_tensor_batch(batch, _CPU)
        for batch in iter_batches(
            cfg,
            encoder,
            split="val",
            batch_size=cfg.train.eval_batch_size,
            seed=cfg.train.seed + 1,
            row_limit=max_rows,
        )
    ]


class ValidationDraw:
    """The run's validation batches, encoded on the first evaluation and replayed at every later one.

    The draw is keyed by what decides it besides the corpus and the tokenizer, which a run does not change: the row
    limit, the evaluation batch size and the seed. A call with a different key encodes again.
    """

    def __init__(self) -> None:
        self._key: tuple[int | None, int, int] | None = None
        self._batches: list[dict[str, Any]] = []

    def batches(
        self, cfg: Config, encoder: mailwoman_mtf.RowEncoder | None, max_rows: int | None
    ) -> list[dict[str, Any]]:
        """The draw's CPU tensor batches, encoding them on the first call for this key."""
        key = (max_rows, int(cfg.train.eval_batch_size), int(cfg.train.seed))
        if key != self._key:
            self._batches = validation_batches(cfg, encoder, max_rows)
            self._key = key
        return self._batches


def to_device(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    """Copy a cached CPU batch's tensors to the training device."""
    return {name: value.to(device) for name, value in batch.items()}
