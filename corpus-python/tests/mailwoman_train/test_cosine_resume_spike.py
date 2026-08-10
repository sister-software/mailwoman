"""P0 cosine-resume one-step peak-LR spike (2026-08-09 audit, HANDOFF-CODEX-TO-CLAUDE §6).

``_restamp_resume_lrs`` overwrites each resumed param group's CURRENT ``lr`` with the live
config's BASE (peak) LR. Under the constant schedule that is a no-op post-warmup (multiplier
1.0), which is why ``test_resume_lr_restamp.py`` — all constant-schedule — never caught it.
Under cosine, the first resumed optimizer step runs at PEAK LR before the next
``scheduler.step()`` restores the tail value: measured 8.808e-06 → 5.000e-04 → 8.805e-06 at
step 55k on v4.3.3 — a 56.8× one-step spike into a nearly-converged model.

Contract pinned here (the repair): after restamp, the group's current LR equals the live
base times the SCHEDULE MULTIPLIER AT THE RESUMED STEP — i.e. an unchanged config resumes at
exactly the checkpoint's tail LR, and a deliberate base-LR change scales the tail
proportionally. The restamp must never hand the raw base to the next optimizer step mid-run.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import torch

from mailwoman_train.train import _build_scheduler, _restamp_resume_lrs, build_optimizer

PEAK_LR = 5e-4
RESUME_STEP = 90  # deep in the cosine tail: multiplier ≈ 0.03, so a peak restamp is a ~33× spike


class _Tiny(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)


def _cosine_cfg() -> SimpleNamespace:
    return SimpleNamespace(lr_schedule="cosine", warmup_steps=10, max_steps=100)


def _train_to_resume_step(lr: float) -> tuple[torch.optim.AdamW, object]:
    model = _Tiny()
    optim, _labels = build_optimizer(model, learning_rate=lr, weight_decay=0.01)
    sched = _build_scheduler(optim, _cosine_cfg())
    for _ in range(RESUME_STEP):
        sched.step()
    return optim, sched


def _resume(tmp_path, live_lr: float) -> tuple[torch.optim.AdamW, object, float]:
    """Save a run at RESUME_STEP, then load it into a fresh build at ``live_lr`` and restamp.
    Returns (optim, scheduler, checkpoint_tail_lr)."""
    optim1, sched1 = _train_to_resume_step(PEAK_LR)
    checkpoint_lr = optim1.param_groups[0]["lr"]
    torch.save(optim1.state_dict(), tmp_path / "optimizer.pt")
    torch.save(sched1.state_dict(), tmp_path / "scheduler.pt")

    model2 = _Tiny()
    optim2, labels = build_optimizer(model2, learning_rate=live_lr, weight_decay=0.01)
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = _build_scheduler(optim2, _cosine_cfg())
    optim2.load_state_dict(torch.load(tmp_path / "optimizer.pt", weights_only=False))
    sched2.load_state_dict(torch.load(tmp_path / "scheduler.pt", weights_only=False))
    _restamp_resume_lrs(optim2, sched2, live_lrs, labels)
    return optim2, sched2, checkpoint_lr


def test_unchanged_config_resumes_at_the_checkpoint_tail_lr(tmp_path) -> None:
    """Same config on both sides: the FIRST resumed optimizer step must run at the LR an
    uninterrupted run would use — the checkpoint's tail value, not the peak."""
    optim2, _sched2, checkpoint_lr = _resume(tmp_path, live_lr=PEAK_LR)

    assert checkpoint_lr < PEAK_LR / 10  # sanity: we really are deep in the tail
    resumed_first_step_lr = optim2.param_groups[0]["lr"]
    assert resumed_first_step_lr == pytest.approx(checkpoint_lr), (
        f"one-step LR spike on cosine resume: first resumed step at {resumed_first_step_lr:g}, "
        f"uninterrupted run would use {checkpoint_lr:g} "
        f"({resumed_first_step_lr / checkpoint_lr:.1f}× transient)"
    )


def test_resumed_schedule_continues_the_uninterrupted_tail(tmp_path) -> None:
    """After the (restamped) resume, subsequent scheduler steps must trace the identical LR
    curve an uninterrupted run traces — both the first step and the following ones."""
    optim1, sched1 = _train_to_resume_step(PEAK_LR)
    optim2, sched2, _checkpoint_lr = _resume(tmp_path, live_lr=PEAK_LR)

    for k in range(3):
        assert optim2.param_groups[0]["lr"] == pytest.approx(optim1.param_groups[0]["lr"]), (
            f"resumed LR diverges from the uninterrupted run {k} step(s) after resume"
        )
        sched1.step()
        sched2.step()


def test_deliberate_base_lr_change_scales_the_tail_not_the_peak(tmp_path) -> None:
    """A live config that halves the base LR must resume at half the checkpoint's TAIL LR —
    the schedule multiplier at the resumed step still applies. Today the group gets the raw
    new base (a spike in the other direction of the same defect)."""
    new_base = PEAK_LR / 2
    optim2, _sched2, checkpoint_lr = _resume(tmp_path, live_lr=new_base)

    expected = checkpoint_lr * (new_base / PEAK_LR)
    resumed_first_step_lr = optim2.param_groups[0]["lr"]
    assert resumed_first_step_lr == pytest.approx(expected), (
        f"changed-base resume must scale the tail LR ({expected:g}), "
        f"not stamp the raw base ({new_base:g}); got {resumed_first_step_lr:g}"
    )
