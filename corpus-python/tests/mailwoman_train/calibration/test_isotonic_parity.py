"""One seeded isotonic fit, pinned through both artifacts it writes.

Nothing exercised this. `main` reads a confidences JSONL that only the TypeScript collector
produces, so the suite has never had one — and the module writes TWO artifacts from one fit: the
lookup table a decoder loads, and the markdown report whose figures are generated rather than
hand-typed. A number that drifts in the report and not in the table, or the reverse, is a report
that no longer describes the table it ships beside.

The fixture draws confidences whose accuracy rises with confidence, so the isotonic fit has a
monotone shape to recover rather than a flat one. Group sizes are chosen so the >=100-eval-span
filter admits both locales and both tags: a fixture below that line would pin `per_locale_ece` and
`per_tag_ece` as empty and measure nothing about the subgroup path.
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path
from typing import Any

import pytest

from mailwoman_train.calibration.isotonic import main

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python -m tests.mailwoman_train.calibration.test_isotonic_parity
REFERENCE = Path(__file__).parent / "isotonic-reference.json"

REFERENCE_README = [
    "Pins one seeded isotonic calibration across a refactor.",
    "Regenerate: uv run python -m tests.mailwoman_train.calibration.test_isotonic_parity",
    "Fixture: write_confidences() in the test beside this file — 2000 spans over two locales and",
    "  two tags, accuracy rising with confidence so the monotone fit has a shape to recover.",
    "",
    "table: the emitted lookup-table JSON, whole — the artifact a decoder loads.",
    "report: the emitted markdown, line by line — every figure in it is generated, so a drift",
    "  here is the report disagreeing with the table it ships beside.",
]

#: 2000 spans over two locales and two tags, each minority group a third of them. The eval split is
#: a fifth, so the smallest group lands ~133 eval spans — over the 100-span floor `group_ece`
#: requires to report, which a quarter-sized group would sit exactly on.
SPAN_COUNT = 2000

#: The fixture's own seed, independent of the one `main` splits and fits with.
FIXTURE_SEED = 20260912


def write_confidences(path: Path) -> None:
    """Write a confidences JSONL at the shape `collect-span-confidences.ts` emits.

    Accuracy rises with confidence and lags it — the model is overconfident, which is the condition
    isotonic exists to correct. A fixture where accuracy equals confidence would fit the identity
    and every before/after figure would be the same number.
    """
    rng = random.Random(FIXTURE_SEED)
    lines = []
    for index in range(SPAN_COUNT):
        conf = round(rng.betavariate(6.0, 1.4), 6)
        accuracy = max(0.0, min(1.0, conf - 0.12 * math.sin(math.pi * conf)))
        lines.append(
            json.dumps(
                {
                    "conf": conf,
                    "correct": rng.random() < accuracy,
                    "source": "oa" if index % 2 else "corpus",
                    "tag": "street" if (index + 1) % 3 else "locality",
                    "country": "us" if index % 3 else "fr",
                }
            )
        )
    path.write_text("\n".join(lines) + "\n")


def run_fit(scratch: Path, patch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Run one fit over the fixture and return both artifacts."""
    confidences = scratch / "confidences.jsonl"
    write_confidences(confidences)
    table = scratch / "table.json"
    report = scratch / "report.md"
    patch.setattr(
        "sys.argv",
        [
            "isotonic",
            "--conf",
            str(confidences),
            "--out",
            str(table),
            "--report",
            str(report),
        ],
    )
    main()
    return {"table": json.loads(table.read_text()), "report": report.read_text().splitlines()}


@pytest.fixture(scope="module")
def fitted(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    patch = pytest.MonkeyPatch()
    try:
        return run_fit(tmp_path_factory.mktemp("isotonic"), patch)
    finally:
        patch.undo()


#: How far a rebuilt figure may sit from the committed one and still count as unmoved.
#:
#: The table carries full-precision floats off numpy reductions — `mean` sums pairwise, and the
#: order that walks depends on SIMD width, so the same inputs can land on a different last digit
#: under a different CPU. Comparing exactly would pin the HOST as well as the code and report a
#: refactor that did not happen. A fit that actually changed moves ECE in the third decimal.
TOLERANCE = 1e-9


def approximately(value: Any) -> Any:
    """`value` with every float inside it wrapped for tolerant comparison, structure preserved."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return pytest.approx(value, rel=TOLERANCE, abs=TOLERANCE)
    if isinstance(value, dict):
        return {key: approximately(item) for key, item in value.items()}
    if isinstance(value, list):
        return [approximately(item) for item in value]
    return value


def test_the_table_matches_the_committed_reference(fitted: dict[str, Any]) -> None:
    """The artifact a decoder loads: the metrics, the subgroups, the curve and the 20 bins."""
    expected = json.loads(REFERENCE.read_text())["table"]
    actual = dict(fitted["table"])
    # `created_from` is the fixture's own scratch path, which differs every run.
    expected.pop("created_from", None)
    actual.pop("created_from", None)
    assert actual == approximately(expected)


def test_the_report_matches_the_committed_reference(fitted: dict[str, Any]) -> None:
    """Every figure in the report is generated from the same fit, so it moves with the table."""
    expected = json.loads(REFERENCE.read_text())["report"]
    actual = fitted["report"]
    assert len(actual) == len(expected), f"the report is {len(actual)} lines, not {len(expected)}"
    drifted = [i for i, (got, want) in enumerate(zip(actual, expected, strict=True)) if got != want]
    assert drifted == [], f"{len(drifted)} line(s) moved, starting at line {drifted[0] + 1}: {actual[drifted[0]]!r}"


def test_the_fixture_reaches_the_subgroup_and_abstention_paths(fitted: dict[str, Any]) -> None:
    """A fixture below the reporting floors would pin empty blocks rather than the code that fills them."""
    table = fitted["table"]
    assert set(table["per_locale_ece"]) == {"us", "fr"}, "a locale fell under the 100-eval-span floor"
    assert set(table["per_tag_ece"]) == {"street", "locality"}, "a tag fell under the 100-eval-span floor"
    assert [row["coverage"] for row in table["abstention_curve"]] != [0.0] * 5, "no threshold accepted a span"
    assert table["metrics"]["ece_cal_eval"] < table["metrics"]["ece_raw_eval"], "the fit did not improve calibration"


def write_reference() -> None:
    """Capture the current fit as the reference the tests above compare against.

    Run this only when the current code already passes against the existing reference — otherwise
    the artifact records whatever the code does now, and the tests assert nothing.
    """
    import tempfile

    patch = pytest.MonkeyPatch()
    try:
        with tempfile.TemporaryDirectory() as scratch:
            fit = run_fit(Path(scratch), patch)
    finally:
        patch.undo()
    fit["table"].pop("created_from", None)
    payload = {"README": REFERENCE_README, **fit}
    REFERENCE.write_text(json.dumps(payload, ensure_ascii=False, indent="\t", sort_keys=False) + "\n")
    print(f"wrote {REFERENCE}")
    print(
        f"  {len(fit['report'])} report lines, ECE {fit['table']['metrics']['ece_raw_eval']:.4f} →"
        f" {fit['table']['metrics']['ece_cal_eval']:.4f}"
    )


if __name__ == "__main__":
    write_reference()
