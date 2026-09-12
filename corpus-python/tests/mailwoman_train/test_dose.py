"""#1677: a dose names the exposure; the weight is derived from it, never picked."""

from __future__ import annotations

import pytest

from mailwoman_train.data.dose import derive_source_weights, format_derivation, total_samples

# The v4.6.0 run the issue measured: 60,000 steps × batch 128, fixed weights summing to 168.
SAMPLES = total_samples(60_000, 128)
FIXED = {"ban": 100.0, "tiger": 56.0, "synth-trailing-region-es-v23": 6.0, "synth-trailing-region-gb-v23": 6.0}
ROWS = {"synth-bare-country-v23": 277, "synth-trailing-region-es-v23": 53_078, "ban": 2_000_000, "tiger": 1_000_000}


def _reps(weights: dict[str, float], src: str) -> float:
    total = sum(w for w in weights.values() if w > 0)
    return weights[src] / total * SAMPLES / ROWS[src]


def test_a_dose_of_five_lands_at_five_reps_per_row():
    merged, derived = derive_source_weights(FIXED, {"synth-bare-country-v23": 5.0}, ROWS, SAMPLES)

    assert merged is not None
    assert _reps(merged, "synth-bare-country-v23") == pytest.approx(5.0)
    # The issue's table: parity with the ES slice is a weight near 0.030, not the 1.0 that was picked.
    assert derived[0].weight == pytest.approx(0.0302, abs=0.0005)
    # The fixed weights are untouched; the dosed draws come out of their share.
    assert {k: merged[k] for k in FIXED} == FIXED


def test_two_doses_hold_together():
    # `tiger` carries a fixed weight, so it cannot also take a dose.
    with pytest.raises(ValueError, match="both a weight and a dose"):
        derive_source_weights(FIXED, {"tiger": 3.0}, ROWS, SAMPLES)

    fixed = {"ban": 100.0}
    merged, derived = derive_source_weights(
        fixed, {"synth-bare-country-v23": 40.0, "synth-trailing-region-es-v23": 8.0}, ROWS, SAMPLES
    )
    assert merged is not None
    assert _reps(merged, "synth-bare-country-v23") == pytest.approx(40.0)
    assert _reps(merged, "synth-trailing-region-es-v23") == pytest.approx(8.0)
    assert len(derived) == 2


def test_no_doses_leaves_the_weights_as_they_were():
    assert derive_source_weights(FIXED, None, ROWS, SAMPLES) == (FIXED, [])
    assert derive_source_weights(None, {}, ROWS, SAMPLES) == (None, [])


def test_refusals_name_the_reason():
    with pytest.raises(ValueError, match="no readable train rows"):
        derive_source_weights(FIXED, {"synth-missing": 5.0}, ROWS, SAMPLES)
    with pytest.raises(ValueError, match="at least one positively weighted source"):
        derive_source_weights({}, {"synth-bare-country-v23": 5.0}, ROWS, SAMPLES)
    with pytest.raises(ValueError, match="at or over the run's"):
        derive_source_weights({"tiger": 1.0}, {"ban": 5.0}, ROWS, total_samples(10, 128))
    with pytest.raises(ValueError, match="must be positive"):
        derive_source_weights(FIXED, {"synth-bare-country-v23": 0.0}, ROWS, SAMPLES)


def test_the_log_line_carries_the_exposure_beside_the_weight():
    _, derived = derive_source_weights(FIXED, {"synth-bare-country-v23": 5.0}, ROWS, SAMPLES)
    text = format_derivation(derived)

    assert "synth-bare-country-v23" in text
    assert "5.000 reps/row" in text
    assert "277 rows" in text
    assert format_derivation([]) == ""


def test_a_fractional_dose_is_printed_not_rounded_to_zero():
    """A probe divides the full run's doses by the step ratio, so its exposures are below one."""
    _, derived = derive_source_weights(FIXED, {"synth-bare-country-v23": 0.0333}, ROWS, SAMPLES)

    assert "0.033 reps/row" in format_derivation(derived)
