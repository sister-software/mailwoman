"""Release-time exposure checks: a preflight before compute is spent, and a completed-run check before promotion.

A *claim* is a ``(jurisdiction, phenomenon)`` pair a shipped locale asserts it handles. A *floor* is the
smallest realized exposure at which an exposure curve showed the phenomenon's behavior stable, with
the report that established it. ``floors.json`` beside this module holds the floors. A floor is added
only from an exposure-curve report. Every phenomenon starts without a floor, and a claim without one
reads ``no-floor``: the check reports its exposure and leaves the verdict to the contrast board.

The preflight reads expected draws: the epoch-1 replay of the mixture, times the epoch count. It
refuses a config whose expected draws for a claimed phenomenon are zero, because training on that
config draws zero rows of it. It applies no floor, because expected draws are an estimate of realized
exposure.

The completed-run check reads realized draws when the trainer logged them, and otherwise reports
that realized exposure is unmeasured rather than substituting the expectation. It refuses a claim
whose realized exposure is under its floor, and any contrast group with a failing arm.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Final

from ..paths import package_path

FLOORS_PATH: Final[Path] = package_path("exposure", "floors.json")

REFUSE: Final[str] = "refuse"
PASS: Final[str] = "pass"
NO_FLOOR: Final[str] = "no-floor"
UNMEASURED: Final[str] = "unmeasured"


@dataclass(frozen=True)
class Finding:
    jurisdiction: str
    phenomenon: str
    verdict: str
    exposure: int | None
    floor: int | None
    reason: str


def load_floors(path: Path = FLOORS_PATH) -> dict[str, dict[str, Any]]:
    """``{phenomenon: {"floor": int, "evidence": str}}``. Each entry must cite the report that set it."""
    floors: dict[str, dict[str, Any]] = json.loads(path.read_text(encoding="utf-8"))["floors"]
    for phenomenon, entry in floors.items():
        if not isinstance(entry.get("floor"), int) or not entry.get("evidence"):
            raise ValueError(f"floor for {phenomenon!r} needs an integer `floor` and the `evidence` report that set it")
    return floors


def _exposure(report: Mapping[str, Any], stage: str, jurisdiction: str, phenomenon: str) -> int | None:
    """Rows exercising ``phenomenon`` at ``stage``, summed over its forms, or None when the stage was not measured."""
    entry = report["jurisdictions"].get(jurisdiction)
    if entry is None:
        return None
    forms = entry["phenomena"].get(phenomenon, {}).get(stage)
    return None if forms is None else sum(forms.values())


def preflight(report: Mapping[str, Any], claims: Iterable[tuple[str, str]], *, epochs: int = 1) -> list[Finding]:
    """Refuse a claim whose expected draws are zero. ``report`` must include the ``replayed_draws`` stage."""
    findings: list[Finding] = []
    for jurisdiction, phenomenon in claims:
        draws = _exposure(report, "replayed_draws", jurisdiction, phenomenon)
        if draws is None:
            findings.append(
                Finding(jurisdiction, phenomenon, UNMEASURED, None, None, "the report holds no replayed_draws stage")
            )
        elif draws == 0:
            findings.append(
                Finding(jurisdiction, phenomenon, REFUSE, 0, None, "the config's mixture draws no row exercising it")
            )
        else:
            findings.append(
                Finding(jurisdiction, phenomenon, PASS, draws * epochs, None, f"expected over {epochs} epoch(s)")
            )
    return findings


def completed_run(
    report: Mapping[str, Any],
    claims: Iterable[tuple[str, str]],
    *,
    floors: Mapping[str, Mapping[str, Any]],
    contrast_failures: Iterable[str] = (),
) -> list[Finding]:
    """Refuse a claim under its floor and every failing contrast row (ids ``<cc>-contrast-<group>-<arm>``)."""
    findings: list[Finding] = []
    for jurisdiction, phenomenon in claims:
        realized = _exposure(report, "realized_draws", jurisdiction, phenomenon)
        floor_entry = floors.get(phenomenon) or {}
        floor = floor_entry.get("floor")
        if realized is None:
            findings.append(
                Finding(jurisdiction, phenomenon, UNMEASURED, None, floor, "the trainer logged no realized draws")
            )
        elif floor is None:
            findings.append(
                Finding(jurisdiction, phenomenon, NO_FLOOR, realized, None, "no exposure curve has set a floor")
            )
        elif realized < floor:
            findings.append(
                Finding(
                    jurisdiction,
                    phenomenon,
                    REFUSE,
                    realized,
                    floor,
                    f"under the floor set by {floor_entry.get('evidence')}",
                )
            )
        else:
            findings.append(Finding(jurisdiction, phenomenon, PASS, realized, floor, "at or over the floor"))
    for case_id in contrast_failures:
        country, _, rest = case_id.partition("-contrast-")
        findings.append(Finding(country.upper(), f"contrast:{rest}", REFUSE, None, None, "contrast arm failed"))
    return findings


def refused(findings: Iterable[Finding]) -> bool:
    return any(finding.verdict == REFUSE for finding in findings)


def as_json(findings: Iterable[Finding]) -> list[dict[str, Any]]:
    return [asdict(finding) for finding in findings]


def main(argv: list[str] | None = None) -> int:
    """Run one stage of the check on an exposure report and exit 1 when it refuses.

    ``python -m mailwoman_train.exposure.release_check preflight --report exposure.json
    --claim RU:streetless-premise-identity [--epochs 8]`` reads the ``replayed_draws`` stage.
    ``completed --report exposure-realized-from-0.json --claim … [--contrast-failure <id> …]`` reads
    ``realized_draws`` and the floors in ``floors.json``.
    """
    import argparse

    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("stage", choices=["preflight", "completed"])
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--claim", action="append", default=[], metavar="CC:PHENOMENON")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--contrast-failure", action="append", default=[])
    args = parser.parse_args(argv)

    report = json.loads(args.report.read_text(encoding="utf-8"))
    claims = [tuple(claim.split(":", 1)) for claim in args.claim]
    findings = (
        preflight(report, claims, epochs=args.epochs)
        if args.stage == "preflight"
        else completed_run(report, claims, floors=load_floors(), contrast_failures=args.contrast_failure)
    )
    print(json.dumps(as_json(findings), indent=2, ensure_ascii=False))
    return 1 if refused(findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
