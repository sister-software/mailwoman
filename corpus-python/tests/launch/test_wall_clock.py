"""Checks the wall-clock preflight's estimate and its refusals."""

from __future__ import annotations

import pytest
from launch.wall_clock import (
    EVALUATION_SECONDS,
    OBSERVED_SECONDS_PER_100_STEPS,
    STARTUP_SHUTDOWN_SECONDS,
    STEP_HEADROOM,
    TRAIN_TIMEOUT_SECONDS,
    check_wall_clock,
    estimate_wall_clock,
)


def test_the_estimate_adds_steps_validation_passes_and_startup() -> None:
    estimate = estimate_wall_clock("A100-40GB", 90_000, 2_000)
    rate = OBSERVED_SECONDS_PER_100_STEPS["A100-40GB"]
    assert estimate.train_seconds == int(90_000 * rate / 100 * STEP_HEADROOM)
    assert estimate.evaluations == 46
    assert estimate.total_seconds == estimate.train_seconds + 46 * EVALUATION_SECONDS + STARTUP_SHUTDOWN_SECONDS


def test_the_bare_a100_name_reads_the_40_gb_rate() -> None:
    assert estimate_wall_clock("A100", 2_000, 2_000).gpu == "A100-40GB"


def test_arm_b_fits_one_attempt_on_an_a100() -> None:
    estimate = check_wall_clock("A100-80GB", 90_000, 2_000, TRAIN_TIMEOUT_SECONDS)
    assert estimate.total_seconds < TRAIN_TIMEOUT_SECONDS


def test_a_run_that_overruns_the_timeout_is_refused() -> None:
    with pytest.raises(RuntimeError, match="max_steps=500000 on A100-40GB"):
        check_wall_clock("A100", 500_000, 2_000, TRAIN_TIMEOUT_SECONDS)


def test_a_gpu_with_no_observed_rate_is_refused() -> None:
    with pytest.raises(ValueError, match="no step rate has been observed on GPU 'L4'"):
        estimate_wall_clock("L4", 2_000, 2_000)
