"""Release-time exposure checks: zero expected draws refuse, a missing floor neither passes nor refuses."""

from __future__ import annotations

from typing import Any

from mailwoman_train.exposure.release_check import (
    NO_FLOOR,
    PASS,
    REFUSE,
    UNMEASURED,
    completed_run,
    load_floors,
    preflight,
    refused,
)


def report(stage: str, forms: dict[str, int] | None) -> dict[str, Any]:
    return {"jurisdictions": {"RU": {"phenomena": {"streetless-premise-identity": {stage: forms}}}}}


CLAIM = [("RU", "streetless-premise-identity")]


def test_committed_floors_are_empty_until_a_curve_sets_one() -> None:
    assert load_floors() == {}


def test_preflight_refuses_zero_expected_draws_and_reports_an_unmeasured_stage() -> None:
    assert preflight(report("replayed_draws", {}), CLAIM)[0].verdict == REFUSE
    assert preflight(report("replayed_draws", {"streetless": 40}), CLAIM, epochs=3)[0].exposure == 120
    assert preflight(report("replayed_draws", None), CLAIM)[0].verdict == UNMEASURED


def test_completed_run_reads_realized_draws_only() -> None:
    floors = {"streetless-premise-identity": {"floor": 1000, "evidence": "exposure-curve-ru.json"}}
    # An expectation is not substituted for an unlogged realization.
    assert completed_run(report("replayed_draws", {"streetless": 5000}), CLAIM, floors=floors)[0].verdict == UNMEASURED
    assert completed_run(report("realized_draws", {"streetless": 999}), CLAIM, floors=floors)[0].verdict == REFUSE
    assert completed_run(report("realized_draws", {"streetless": 1000}), CLAIM, floors=floors)[0].verdict == PASS
    assert completed_run(report("realized_draws", {"streetless": 1}), CLAIM, floors={})[0].verdict == NO_FLOOR


def test_a_failing_contrast_arm_refuses_promotion() -> None:
    findings = completed_run(
        report("realized_draws", {"streetless": 1}),
        CLAIM,
        floors={},
        contrast_failures=["ru-contrast-six-digit-postcode-ru-native"],
    )
    assert refused(findings)
    assert findings[-1].jurisdiction == "RU"
    assert findings[-1].phenomenon == "contrast:six-digit-postcode-ru-native"
