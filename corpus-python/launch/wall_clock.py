"""The wall-clock budget a training run needs on a given GPU, from step rates observed on Modal.

The preflight refuses a config whose estimate exceeds the training function's timeout, so a run that
cannot finish inside one attempt fails before a GPU is billed. A GPU with no observed rate is refused
too: the estimate would be a guess, and a slow card can push a recipe past the timeout.

The estimate has three parts:

- the training steps, at the GPU's observed seconds per 100 optimizer steps at the config's batch size between
  validation passes, times ``STEP_HEADROOM`` for slow batches and checkpoint writes;
- the validation passes, ``max_steps // eval_every_steps + 1`` of them, at ``EVALUATION_SECONDS`` each;
- ``STARTUP_SHUTDOWN_SECONDS`` outside the step loop.
"""

from __future__ import annotations

from dataclasses import dataclass

#: The training function's wall-clock budget per attempt, 32,400 s (9 h). The estimate below puts a 90,000-step
#: A100 recipe evaluated every 2,000 steps at about 9,900 s.
TRAIN_TIMEOUT_SECONDS = 32400

#: Seconds per 100 optimizer steps between validation passes, by Modal GPU type and then by batch size. A batch with no
#: measured row is refused rather than scaled from batch 128, because no per-batch measurement supports a scaling rule.
#:
#: ``A100-40GB``: the two 90,000-step runs ``v8.3.0-base-c6-90k-fp32master-s42`` and ``-s43`` (2026-10-29) keep
#: fp32 parameters under bf16 autocast. They ran at a median 7.2 and 7.0 s per 100 steps over 932 and 837 windows
#: (10th to 90th percentile 6.8 to 7.8), read from their train_log.csv. The Rust trainer is faster on the same card,
#: so its runs are estimated from above. The earlier bf16-cast loop ran 6.50 s. Fp32 master weights are slower.
#:
#: ``A100-80GB`` reuses the 40 GB rate. It has the same compute and more memory bandwidth, so the 40 GB rate bounds
#: it from above. That bound is inferred, and no run has measured the 80 GB card.
OBSERVED_SECONDS_PER_100_STEPS: dict[str, dict[int, float]] = {
    "A100-40GB": {128: 7.20},
    "A100-80GB": {128: 7.20},
}

#: Seconds per 100 steps for the dev-only CPU device the Rust lifecycle checks run on (`launch/train_rust.py`'s
#: `_train_rust_cpu`). Unlike the GPU rows it is at the 200-step trainer-parity config's batch 8: `trainer train` on the
#: lab CPU at 4 threads ran steps 10 to 100 in 39.0 s (`$MAILWOMAN_DATA_ROOT/audits/trainer-parity/rust-smoke/`). No
#: recipe trains on this device, so the row only lets that small job's preflight write its receipt.
DEV_OBSERVED_SECONDS_PER_100_STEPS: dict[str, dict[int, float]] = {"cpu": {8: 43.3}}

#: Modal accepts ``A100`` for the 40 GB card.
GPU_ALIASES: dict[str, str] = {"A100": "A100-40GB"}

#: Multiplicative headroom over the step time for slow batches and checkpoint writes.
STEP_HEADROOM = 1.15

#: Seconds per validation pass. An attempt encodes its validation draw at the first pass and replays it after.
#: The two fp32-master runs above measured a first pass of 145.5 and 140.2 s and a replayed pass of a median 7.6 s.
#: Their mean over every pass, restarts included, was 13.4 and 14.1 s over 46 and 41 passes.
EVALUATION_SECONDS = 15

#: A flat allowance for the image start, the preflight receipt check and the final save.
STARTUP_SHUTDOWN_SECONDS = 1800


@dataclass(frozen=True)
class WallClockEstimate:
    """A run's estimated wall clock on one GPU, by part."""

    gpu: str
    batch_size: int
    seconds_per_100_steps: float
    train_seconds: int
    evaluations: int
    evaluation_seconds: int
    total_seconds: int


def estimate_wall_clock(gpu: str, max_steps: int, eval_every_steps: int, batch_size: int) -> WallClockEstimate:
    """The wall clock ``max_steps`` steps of ``batch_size`` rows need on ``gpu``.

    Raises ``ValueError`` for a GPU, or a batch size on it, with no observed rate, naming the ones that have one.
    """
    card = GPU_ALIASES.get(gpu, gpu)
    rates = OBSERVED_SECONDS_PER_100_STEPS.get(card, DEV_OBSERVED_SECONDS_PER_100_STEPS.get(card))
    if rates is None:
        known = ", ".join(sorted(OBSERVED_SECONDS_PER_100_STEPS))
        raise ValueError(
            f"no step rate has been observed on GPU {gpu!r} (observed: {known}); measure one with a 2,000-step "
            "probe and add it to OBSERVED_SECONDS_PER_100_STEPS in launch/wall_clock.py"
        )
    rate = rates.get(batch_size)
    if rate is None:
        known = ", ".join(str(b) for b in sorted(rates))
        raise ValueError(
            f"no step rate has been observed on {card} at batch_size={batch_size} (observed batches: {known}); "
            "measure one with a 2,000-step probe at that batch and add it to OBSERVED_SECONDS_PER_100_STEPS"
        )
    if max_steps <= 0 or eval_every_steps <= 0:
        raise ValueError(f"max_steps={max_steps} and eval_every_steps={eval_every_steps} must be positive")

    train_seconds = int(max_steps * rate / 100 * STEP_HEADROOM)
    evaluations = max_steps // eval_every_steps + 1
    evaluation_seconds = evaluations * EVALUATION_SECONDS
    return WallClockEstimate(
        gpu=card,
        batch_size=batch_size,
        seconds_per_100_steps=rate,
        train_seconds=train_seconds,
        evaluations=evaluations,
        evaluation_seconds=evaluation_seconds,
        total_seconds=train_seconds + evaluation_seconds + STARTUP_SHUTDOWN_SECONDS,
    )


def check_wall_clock(
    gpu: str, max_steps: int, eval_every_steps: int, batch_size: int, timeout_seconds: int
) -> WallClockEstimate:
    """The estimate, or ``RuntimeError`` when it exceeds ``timeout_seconds``."""
    estimate = estimate_wall_clock(gpu, max_steps, eval_every_steps, batch_size)
    if estimate.total_seconds > timeout_seconds:
        raise RuntimeError(
            f"max_steps={max_steps} on {estimate.gpu} needs ~{estimate.total_seconds}s wall clock: "
            f"{estimate.train_seconds}s of steps ({estimate.seconds_per_100_steps} s per 100 steps observed, "
            f"x{STEP_HEADROOM} headroom), {estimate.evaluations} validation passes at {EVALUATION_SECONDS}s, "
            f"+{STARTUP_SHUTDOWN_SECONDS}s startup and shutdown. The train function's timeout is {timeout_seconds}s. "
            "Shorten the run, evaluate less often, or raise TRAIN_TIMEOUT_SECONDS deliberately."
        )
    return estimate
