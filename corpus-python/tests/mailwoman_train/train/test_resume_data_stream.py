"""A run interrupted at step N and resumed trains on the same batches from step N on as an uninterrupted run.

Both runs train the two-row probe corpus of `test_train_loop_trace` on CPU with one row per batch, so each epoch is
two batches and a resume at an odd step lands inside an epoch. The batches are recorded where the loop converts
them to tensors.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any
from unittest import mock

from mailwoman_train.train import loop as loop_module
from mailwoman_train.train.trainer import train
from tests.mailwoman_train.train.test_train_loop_trace import _probe_config

MAX_STEPS = 5


def _trained_batches(cfg: Any, resume_from: Path | None = None) -> list[str]:
    """Train `cfg` and return a fingerprint of each batch the loop converted, in training order."""
    seen: list[str] = []
    convert = loop_module.to_tensor_batch

    def recording(batch: dict[str, Any], device: Any) -> Any:
        seen.append(repr(batch["char_ids"]))
        return convert(batch, device)

    with mock.patch.object(loop_module, "to_tensor_batch", recording):
        train(cfg, resume_from=resume_from)
    return seen


def _config(root: Path) -> Any:
    cfg = _probe_config(root)
    cfg.train.batch_size = 1
    cfg.train.max_steps = MAX_STEPS
    cfg.train.save_every_steps = 1
    return cfg


def test_a_resumed_run_trains_on_the_batches_an_uninterrupted_run_trains_on(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    uninterrupted = _trained_batches(cfg)
    assert len(uninterrupted) == MAX_STEPS
    # The two rows alternate within an epoch, so a stream restarted at epoch 1 reads a different batch at step 1.
    assert len(set(uninterrupted)) == 2

    output = Path(cfg.train.output_dir)
    for resume_step in (1, 2, 3):
        checkpoint = output / f"step-{resume_step:06d}"
        kept = tmp_path / f"kept-{resume_step}"
        shutil.copytree(checkpoint, kept)
        resumed_cfg = _config(tmp_path / f"resumed-{resume_step}")
        resumed = _trained_batches(resumed_cfg, resume_from=kept)
        assert resumed == uninterrupted[resume_step:], resume_step
