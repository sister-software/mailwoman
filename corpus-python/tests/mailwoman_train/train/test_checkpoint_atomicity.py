from __future__ import annotations

from pathlib import Path

import pytest
import torch

from mailwoman_train.train.checkpoint import find_latest_checkpoint, save_checkpoint


class _Tiny(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.lin = torch.nn.Linear(2, 2)


def test_find_latest_skips_a_partial_checkpoint(tmp_path: Path) -> None:
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
    out = tmp_path / "checkpoints"
    with pytest.raises(TypeError):
        save_checkpoint(_Tiny(), out, 400, {"unserializable": object()})

    assert list(out.glob("step-*")) == [], (
        f"mid-save failure left a visible partial checkpoint: {[p.name for p in out.glob('step-*')]}"
    )
    assert find_latest_checkpoint(out) is None


def test_successful_save_is_complete_and_leaves_no_temp_litter(tmp_path: Path) -> None:
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
