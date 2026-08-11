"""P1 checkpoint atomicity (2026-08-09 training-substrate audit, HANDOFF-CODEX-TO-CLAUDE §6).

``save_checkpoint`` creates the final ``step-XXXXXX`` directory and writes files into it
sequentially, and ``find_latest_checkpoint`` picks the highest ``step-*`` name with no
completeness check. An interruption mid-save (the exact crash-and-resume loop the docstring
promises to survive) therefore leaves a partial directory that the next ``--resume auto``
happily loads.

Contract pinned here (the repair): a checkpoint directory named ``step-*`` is either
COMPLETE or ABSENT. Writes go to a temp name the ``step-*`` glob cannot see, then rename
into place after everything (``training_state.json`` last) is written; the completeness
marker for discovery is the presence of ``training_state.json`` — which every durable
historical checkpoint already carries, so old volumes keep resuming.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import torch

from mailwoman_train.train import find_latest_checkpoint, save_checkpoint


class _Tiny(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.lin = torch.nn.Linear(2, 2)


def test_find_latest_skips_a_partial_checkpoint(tmp_path: Path) -> None:
    """A higher-step directory missing training_state.json (killed mid-save) must be
    ignored in favor of the highest COMPLETE checkpoint."""
    out = tmp_path / "checkpoints"
    complete = save_checkpoint(_Tiny(), out, 100, {"step": 100})
    assert complete.name == "step-000100"

    partial = out / "step-000200"
    partial.mkdir()
    (partial / "pytorch_model.bin").write_bytes(b"truncated by a mid-save kill")

    assert find_latest_checkpoint(out) == complete, (
        "find_latest_checkpoint picked the partial step-000200 over the complete step-000100"
    )


def test_find_latest_returns_none_when_only_partials_exist(tmp_path: Path) -> None:
    out = tmp_path / "checkpoints"
    partial = out / "step-000300"
    partial.mkdir(parents=True)
    (partial / "optimizer.pt").write_bytes(b"orphan")

    assert find_latest_checkpoint(out) is None


def test_failed_save_leaves_no_step_directory(tmp_path: Path) -> None:
    """A save that dies partway (here: unserializable extras, after the model file is
    already written) must not leave anything a ``step-*`` discovery can see."""
    out = tmp_path / "checkpoints"
    with pytest.raises(TypeError):
        save_checkpoint(_Tiny(), out, 400, {"unserializable": object()})

    assert list(out.glob("step-*")) == [], (
        f"mid-save failure left a visible partial checkpoint: {[p.name for p in out.glob('step-*')]}"
    )
    assert find_latest_checkpoint(out) is None


def test_successful_save_is_complete_and_leaves_no_temp_litter(tmp_path: Path) -> None:
    """The success path end-state: exactly the final directory, all files inside, no temp
    residue for the next save/discovery to trip on."""
    out = tmp_path / "checkpoints"
    model = _Tiny()
    optim = torch.optim.AdamW(model.parameters(), lr=1e-4)
    ck = save_checkpoint(model, out, 500, {"step": 500}, optim=optim)

    assert ck == out / "step-000500"
    assert (ck / "pytorch_model.bin").is_file()
    assert (ck / "optimizer.pt").is_file()
    assert (ck / "training_state.json").is_file()
    assert {p.name for p in out.iterdir()} == {"step-000500"}
    assert find_latest_checkpoint(out) == ck
