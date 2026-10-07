"""Assemble an exposure curve: per arm, the requested weight, expected and realized draws, and the held-out result.

Usage::

    python -m mailwoman_train.exposure.curve --source osm-ru --country RU \\
        --arm d0=configs/v4.15.0-ru-exposure-d0-2k.yaml,realized-d0.json,grade-d0.json \\
        --arm d100=... --json curve.json

Each ``--arm`` names a label, the arm's config, the trainer's ``exposure-realized-from-0.json`` and the
``grade_exposure`` report. The expected draws are read off the config: the source's weight share of
``max_steps × batch_size``, the arithmetic the d0 config's header states. Realized draws are the
trainer's count of the country's rows in consumed batches, so they include rows of the country from
every source. The expected column counts only that source. Both are reported, side by side.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from ..audits.epoch_mixture.passes import requested_shares
from ..config import load_config


def expected_draws(cfg: Any, source: str) -> float:
    """The source's expected draws over the run, from its weight share.

    A source weighted through ``source_reps`` has a weight only after ``resolve_config_reps`` has read
    the corpus, so a caller grading such a config resolves it first. The v4.15.0 arms weight every
    source directly.
    """
    share = requested_shares(cfg.data.source_weights).get(source, 0.0)
    return float(share * cfg.train.max_steps * cfg.train.batch_size)


def arm_row(
    label: str, config: Path, realized: Path | None, grade: Path | None, *, source: str, country: str
) -> dict[str, Any]:
    cfg = load_config(config)
    row: dict[str, Any] = {
        "arm": label,
        "config": config.name,
        "weight": (cfg.data.source_weights or {}).get(source),
        "expected_source_draws": round(expected_draws(cfg, source), 1),
        "realized_country_draws": None,
        "realized_phenomena": None,
        "heldout": None,
    }
    if realized is not None and realized.exists():
        report = json.loads(realized.read_text(encoding="utf-8"))
        entry = report["jurisdictions"].get(country)
        stage = entry["stages"]["realized_draws"] if entry else {"total": 0}
        row["realized_country_draws"] = stage["total"] if stage else None
        row["realized_phenomena"] = (
            {p: v["realized_draws"] for p, v in entry["phenomena"].items() if v.get("realized_draws")} if entry else {}
        )
    if grade is not None and grade.exists():
        row["heldout"] = json.loads(grade.read_text(encoding="utf-8"))["groups"]
    return row


def render_markdown(rows: list[dict[str, Any]], groups: list[str]) -> str:
    header = ["arm", "weight", "expected source draws", "realized country draws", *groups]
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for row in rows:
        cells = [row["arm"], str(row["weight"]), f"{row['expected_source_draws']:,.0f}"]
        cells.append("unmeasured" if row["realized_country_draws"] is None else f"{row['realized_country_draws']:,}")
        for group in groups:
            entry = (row["heldout"] or {}).get(group)
            cells.append("unmeasured" if entry is None else f"{entry['correct']}/{entry['rows']}")
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> dict[str, Any]:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True)
    parser.add_argument("--country", required=True)
    parser.add_argument("--arm", action="append", required=True, metavar="LABEL=CONFIG,REALIZED,GRADE")
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args(argv)

    rows = []
    for spec in args.arm:
        label, _, paths = spec.partition("=")
        config, realized, grade = (paths.split(",") + ["", ""])[:3]
        rows.append(
            arm_row(
                label,
                Path(config),
                Path(realized) if realized else None,
                Path(grade) if grade else None,
                source=args.source,
                country=args.country,
            )
        )
    groups = sorted({g for row in rows for g in (row["heldout"] or {})}, key=lambda g: (g != "*", g))
    report = {"source": args.source, "country": args.country, "arms": rows}
    args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    args.json.with_suffix(".md").write_text(render_markdown(rows, groups), encoding="utf-8")
    print(render_markdown(rows, groups))
    return report


if __name__ == "__main__":
    main()
