"""The WSD-style cooldown branch (2026-08-10 recipe review, change 11).

Every v4.3.3 checkpoint was graded mid-cosine at 26–93% of peak LR; the schedule literature
(Chinchilla schedule-matching; Hägele et al. 2024; MiniCPM) says such reads systematically
understate the finished model, and that decaying a mid-run checkpoint's LR to zero over a
short branch recovers approximately the matched-schedule endpoint.

Contract pinned here: ``lr_schedule: linear_cooldown`` with ``cooldown_start_step`` holds
multiplier 1.0 through the resume point and decays linearly to zero at ``max_steps``. The
config's ``learning_rate`` is set to the parent checkpoint's CURRENT (tail) LR, so with the
schedule-aware restamp the first resumed optimizer step continues exactly where the parent
left off — no spike in either direction — and the branch ends at zero.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import torch

from mailwoman_train.train import _build_scheduler, _restamp_resume_lrs, build_optimizer

PARENT_PEAK_LR = 5e-4
PARENT_CFG = SimpleNamespace(lr_schedule="cosine", warmup_steps=1000, max_steps=60000)
BRANCH_START = 40000
BRANCH_END = 46000


class _Tiny(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)


def _branch_cfg() -> SimpleNamespace:
    return SimpleNamespace(
        lr_schedule="linear_cooldown",
        cooldown_start_step=BRANCH_START,
        max_steps=BRANCH_END,
        warmup_steps=0,
    )


def test_multiplier_is_unity_through_the_start_then_linear_to_zero() -> None:
    model = _Tiny()
    optim, _labels = build_optimizer(model, learning_rate=1e-4, weight_decay=0.01)
    sched = _build_scheduler(optim, _branch_cfg())
    lambda_fn = sched.lr_lambdas[0]

    assert lambda_fn(0) == 1.0
    assert lambda_fn(BRANCH_START) == 1.0
    assert lambda_fn(BRANCH_START + 3000) == pytest.approx(0.5)
    assert lambda_fn(BRANCH_END) == 0.0
    assert lambda_fn(BRANCH_END + 100) == 0.0


def test_missing_cooldown_start_step_raises() -> None:
    model = _Tiny()
    optim, _labels = build_optimizer(model, learning_rate=1e-4, weight_decay=0.01)
    cfg = _branch_cfg()
    cfg.cooldown_start_step = None
    with pytest.raises(ValueError, match="cooldown_start_step"):
        _build_scheduler(optim, cfg)


def test_branch_resume_continues_the_parent_tail_exactly(tmp_path) -> None:
    """End-to-end: run the parent cosine to 40k, save, resume under linear_cooldown with the
    config LR set to the parent's tail value — the first branch step must run at exactly the
    parent's 40k LR, then decay linearly to zero at 46k."""
    parent = _Tiny()
    optim1, _l1 = build_optimizer(parent, learning_rate=PARENT_PEAK_LR, weight_decay=0.01)
    sched1 = _build_scheduler(optim1, PARENT_CFG)
    for _ in range(BRANCH_START):
        sched1.step()
    parent_tail_lr = optim1.param_groups[0]["lr"]
    assert parent_tail_lr < PARENT_PEAK_LR / 3  # sanity: deep in the parent's tail
    torch.save(optim1.state_dict(), tmp_path / "optimizer.pt")
    torch.save(sched1.state_dict(), tmp_path / "scheduler.pt")

    branch = _Tiny()
    optim2, labels = build_optimizer(branch, learning_rate=parent_tail_lr, weight_decay=0.01)
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = _build_scheduler(optim2, _branch_cfg())
    optim2.load_state_dict(torch.load(tmp_path / "optimizer.pt", weights_only=False))
    sched2.load_state_dict(torch.load(tmp_path / "scheduler.pt", weights_only=False))
    _restamp_resume_lrs(optim2, sched2, live_lrs, labels)

    assert optim2.param_groups[0]["lr"] == pytest.approx(parent_tail_lr)

    for _ in range(3000):
        sched2.step()
    assert optim2.param_groups[0]["lr"] == pytest.approx(parent_tail_lr * 0.5)
    for _ in range(3000):
        sched2.step()
    assert optim2.param_groups[0]["lr"] == pytest.approx(0.0, abs=1e-12)


def test_strict_config_accepts_cooldown_start_step(tmp_path) -> None:
    """#1248 strict config: the new key must be a declared TrainConfig field, not an unknown."""
    from mailwoman_train.config import TrainConfig

    assert hasattr(TrainConfig(), "cooldown_start_step")
    assert TrainConfig().cooldown_start_step is None
