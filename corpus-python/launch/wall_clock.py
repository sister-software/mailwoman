"""The wall-clock budget a training run needs on a given GPU, from step rates observed on Modal.

The preflight refuses a config whose estimate exceeds the training function's timeout, so a run that
cannot finish inside one attempt fails before a GPU is billed. A GPU with no observed rate is refused
too: the estimate would be a guess, and a slow card can push a recipe past the timeout.

The estimate has three parts:

- the training steps, at the GPU's observed seconds per 100 optimizer steps (batch 128) between
  validation passes, times ``STEP_HEADROOM`` for slow batches and checkpoint writes;
- the validation passes, ``max_steps // eval_every_steps + 1`` of them, at ``EVALUATION_SECONDS`` each;
- ``STARTUP_SHUTDOWN_SECONDS`` outside the step loop.
"""

from __future__ import annotations

from dataclasses import dataclass

#: The training function's wall-clock budget per attempt, 32,400 s (9 h). The estimate below puts a 90,000-step
#: A100 recipe evaluated every 2,000 steps at about 24,900 s.
TRAIN_TIMEOUT_SECONDS = 32400

#: Seconds per 100 optimizer steps at batch 128, between validation passes, by Modal GPU type.
#:
#: ``A100-40GB``: the 2,000-step probe ``v8.3.0-probe-rust-loader-2k.yaml`` (call fc-01M62R4Y9MDJW0WMAHRR5KVGQ6,
#: 2026-10-29) ran the Rust row encoder at a median 6.50 s per 100 steps over steps 300 to 2,000 (17 windows,
#: 6.10 to 7.70), read from its train_log.csv. Runs on the Python encoder it replaced ran 16.2 to 24.4 s.
#:
#: ``A100-80GB`` reuses the 40 GB rate. It has the same compute and more memory bandwidth, so the 40 GB rate bounds
#: it from above. That bound is inferred, and no run has measured the 80 GB card.
OBSERVED_SECONDS_PER_100_STEPS: dict[str, float] = {
    "A100-40GB": 6.50,
    "A100-80GB": 6.50,
}

#: Modal accepts ``A100`` for the 40 GB card.
GPU_ALIASES: dict[str, str] = {"A100": "A100-40GB"}

#: Multiplicative headroom over the step time for slow batches and checkpoint writes.
STEP_HEADROOM = 1.15

#: Seconds per validation pass. 355 s is the median over the 44 passes of the seed 42 arm B run
#: (``v8.3.0-base-c6-90k-mixed-s42``, 2026-10-27). That run's validation rows sat inside the training files.
#: Its seed 43 run measured 363 s over 44. The validation draw is now encoded once and replayed. No Modal run
#: has measured a replayed pass, so this figure is an upper bound.
EVALUATION_SECONDS = 355

#: A flat allowance for the image start, the preflight receipt check and the final save.
STARTUP_SHUTDOWN_SECONDS = 1800


@dataclass(frozen=True)
class WallClockEstimate:
    """A run's estimated wall clock on one GPU, by part."""

    gpu: str
    seconds_per_100_steps: float
    train_seconds: int
    evaluations: int
    evaluation_seconds: int
    total_seconds: int


def estimate_wall_clock(gpu: str, max_steps: int, eval_every_steps: int) -> WallClockEstimate:
    """The wall clock ``max_steps`` steps need on ``gpu``.

    Raises ``ValueError`` for a GPU with no observed rate, naming the GPUs that have one.
    """
    card = GPU_ALIASES.get(gpu, gpu)
    rate = OBSERVED_SECONDS_PER_100_STEPS.get(card)
    if rate is None:
        known = ", ".join(sorted(OBSERVED_SECONDS_PER_100_STEPS))
        raise ValueError(
            f"no step rate has been observed on GPU {gpu!r} (observed: {known}); measure one with a 2,000-step "
            "probe and add it to OBSERVED_SECONDS_PER_100_STEPS in launch/wall_clock.py"
        )
    if max_steps <= 0 or eval_every_steps <= 0:
        raise ValueError(f"max_steps={max_steps} and eval_every_steps={eval_every_steps} must be positive")

    train_seconds = int(max_steps * rate / 100 * STEP_HEADROOM)
    evaluations = max_steps // eval_every_steps + 1
    evaluation_seconds = evaluations * EVALUATION_SECONDS
    return WallClockEstimate(
        gpu=card,
        seconds_per_100_steps=rate,
        train_seconds=train_seconds,
        evaluations=evaluations,
        evaluation_seconds=evaluation_seconds,
        total_seconds=train_seconds + evaluation_seconds + STARTUP_SHUTDOWN_SECONDS,
    )


def check_wall_clock(gpu: str, max_steps: int, eval_every_steps: int, timeout_seconds: int) -> WallClockEstimate:
    """The estimate, or ``RuntimeError`` when it exceeds ``timeout_seconds``."""
    estimate = estimate_wall_clock(gpu, max_steps, eval_every_steps)
    if estimate.total_seconds > timeout_seconds:
        raise RuntimeError(
            f"max_steps={max_steps} on {estimate.gpu} needs ~{estimate.total_seconds}s wall clock: "
            f"{estimate.train_seconds}s of steps ({estimate.seconds_per_100_steps} s per 100 steps observed, "
            f"x{STEP_HEADROOM} headroom), {estimate.evaluations} validation passes at {EVALUATION_SECONDS}s, "
            f"+{STARTUP_SHUTDOWN_SECONDS}s startup and shutdown. The train function's timeout is {timeout_seconds}s. "
            "Shorten the run, evaluate less often, or raise TRAIN_TIMEOUT_SECONDS deliberately."
        )
    return estimate
