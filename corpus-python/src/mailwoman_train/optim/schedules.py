"""Learning-rate schedules, and the restamp a resume needs.

Three shapes, chosen by `train.lr_schedule`. The restamp exists because loading an optimizer state
dict silently discards the live config's learning rates; see `restamp_resume_lrs`.
"""

from __future__ import annotations

import math
from typing import Any

from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR


def cosine_with_warmup(optimizer: AdamW, warmup_steps: int, max_steps: int) -> LambdaLR:
    def lr_lambda(step: int) -> float:
        if step < warmup_steps:
            return float(step) / float(max(1, warmup_steps))
        progress = float(step - warmup_steps) / float(max(1, max_steps - warmup_steps))
        progress = min(1.0, progress)
        return max(0.0, 0.5 * (1.0 + math.cos(math.pi * progress)))

    return LambdaLR(optimizer, lr_lambda)


def linear_cooldown(optimizer: AdamW, cooldown_start: int, max_steps: int) -> LambdaLR:
    """WSD-style decay branch (2026-08-10 recipe review, setting 11).

    Resume a mid-schedule checkpoint at ``cooldown_start`` with the config's ``learning_rate``
    set to that checkpoint's CURRENT (tail) LR: the multiplier holds 1.0 through the start, so
    the schedule-aware restamp continues the parent's LR exactly, then decays linearly to zero
    at ``max_steps``. Approximates the matched-schedule endpoint of a mid-cosine checkpoint
    without a full rerun (Hägele et al. 2024, arXiv:2405.18392; MiniCPM, arXiv:2404.06395;
    Chinchilla's schedule-matching finding).
    """
    span = max(1, max_steps - cooldown_start)

    def lr_lambda(step: int) -> float:
        if step <= cooldown_start:
            return 1.0
        return max(0.0, float(max_steps - step) / float(span))

    return LambdaLR(optimizer, lr_lambda)


def constant_with_warmup(optimizer: AdamW, warmup_steps: int) -> LambdaLR:
    # Linear warmup → constant. The verdict-smoke mode per v0.5.0: cosine decay over a short
    # window collapses the LR before divergence shows in the loss curve.
    def lr_lambda(step: int) -> float:
        if step < warmup_steps:
            return float(step) / float(max(1, warmup_steps))
        return 1.0

    return LambdaLR(optimizer, lr_lambda)


def build_scheduler(optim: AdamW, cfg_train: Any) -> LambdaLR:
    schedule = getattr(cfg_train, "lr_schedule", "cosine")
    if schedule == "constant":
        return constant_with_warmup(optim, cfg_train.warmup_steps)
    if schedule == "cosine":
        return cosine_with_warmup(optim, cfg_train.warmup_steps, cfg_train.max_steps)
    if schedule == "linear_cooldown":
        start = getattr(cfg_train, "cooldown_start_step", None)
        if start is None:
            raise ValueError("train.lr_schedule='linear_cooldown' requires train.cooldown_start_step")
        return linear_cooldown(optim, int(start), cfg_train.max_steps)
    raise ValueError(f"unknown train.lr_schedule={schedule!r}; expected 'cosine', 'constant', or 'linear_cooldown'")


def restamp_resume_lrs(
    optim: AdamW,
    scheduler: LambdaLR,
    live_lrs: list[float],
    labels: list[str],
) -> None:
    """Put the config's learning rates back after a resume has overwritten them.

    Loading an optimizer checkpoint replaces every learning rate with the one the checkpoint was
    saved with, and loading a scheduler checkpoint does the same to its base rates. So a resumed run
    silently ignores any rate change in the config and trains at the old value, while the startup
    log reports the new one as if it had taken effect. This puts the config's values back.

    Two rates are involved and they are not the same number. The config specifies a PEAK rate; a
    group's current rate is that peak times wherever the schedule has got to. Writing the peak
    directly gives the first resumed step a rate far above where the run left off — resuming a
    nearly-converged model at step 55,000 measured 8.808e-06 jumping to 5.000e-04 before the next
    scheduler step pulled it back, a 57-fold spike. So the peak goes to the places that hold peaks,
    and the current rate is computed from it by asking the scheduler for its multiplier at the step
    being resumed.

    `live_lrs` must come from the fresh optimizer before the checkpoint is loaded, and `labels` must
    be the list `build_optimizer` returned, unmodified. The two are positional: `labels[i]` names
    `optim.param_groups[i]`. Building that list by hand instead would duplicate `build_optimizer`'s
    carve-out order, and reordering there would make the printed attribution wrong while the rates
    stayed correct. A length mismatch means that contract was broken, so the zip fails loudly rather
    than truncating.

    Prints one line per group whose rate the checkpoint had changed, and nothing when the checkpoint
    already agreed with the config.
    """
    lr_lambdas = getattr(scheduler, "lr_lambdas", None)
    for i, (pg, live_lr, label) in enumerate(zip(optim.param_groups, live_lrs, labels, strict=True)):
        mult = lr_lambdas[i](scheduler.last_epoch) if lr_lambdas is not None else 1.0
        live_current_lr = live_lr * mult
        checkpoint_lr = pg["lr"]
        if checkpoint_lr != live_current_lr:
            print(f"[resume-lr] group {i} ({label}): checkpoint {checkpoint_lr} -> config {live_current_lr}")
        pg["lr"] = live_current_lr
        if "initial_lr" in pg:
            pg["initial_lr"] = live_lr
    if hasattr(scheduler, "base_lrs"):
        scheduler.base_lrs = list(live_lrs)
