#!/usr/bin/env python3
# @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
#
# Per-tag score trends from the eval ledger (stretch S5, night-11). The scorecards keep saying
# "see the latest"; this gives them a trend page to point at. Reads evals/scores-by-version.json
# (every shape the ledger has carried across eras), emits a version × tag matrix per locale.
#
# Regenerate: python3 scripts/eval/build-score-trends.py
# Output: docs/articles/evals/score-trends.md (GENERATED — do not hand-edit)

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LEDGER = REPO / "evals/scores-by-version.json"
OUT = REPO / "docs/articles/evals/score-trends.md"

TAG_ORDER = [
    "micro", "street", "street_prefix", "street_suffix", "house_number", "locality", "region",
    "postcode", "country_homograph", "unit", "po_box_real", "cedex_real", "intersection_real",
    "native_locality_anchor_on",
]


def normalize(run: dict) -> dict[str, dict[str, float]]:
    """Whatever era the run is from → {locale: {tag: score}} (percent scale)."""
    m = run.get("metrics", {})
    container = next((m[k] for k in m if k.startswith("per_component")), None)
    if container is None and any(k in m for k in ("us", "fr", "de")):
        container = m  # v4.4.0-era: locale dict at the top
    if container is None:
        return {}
    out: dict[str, dict[str, float]] = {}
    if any(k in container for k in ("us", "fr", "de")):
        for locale, tags in container.items():
            if not isinstance(tags, dict):
                continue
            out[locale] = {t: float(v) for t, v in tags.items() if isinstance(v, (int, float))}
    else:
        # Pre-locale era: flat tag → {f1: 0-1 fraction}; report as US (the only graded locale then).
        out["us"] = {
            t: round(float(v.get("f1", 0)) * 100, 1)
            for t, v in container.items()
            if isinstance(v, dict)
        }
    return out


def main() -> None:
    ledger = json.loads(LEDGER.read_text())
    rows = []  # (version, locale_scores)
    seen_versions = set()
    for run in ledger["runs"]:
        version = str(run.get("model_version", "?"))
        scores = normalize(run)
        if not scores:
            continue
        # One row per version: the LAST ledger entry for a version wins (re-measurements supersede).
        if version in seen_versions:
            rows = [(v, s) for v, s in rows if v != version]
        seen_versions.add(version)
        rows.append((version, scores))

    lines = [
        "# Per-tag score trends",
        "",
        "GENERATED from [`evals/scores-by-version.json`](https://github.com/sister-software/mailwoman/blob/main/evals/scores-by-version.json)",
        "by `scripts/eval/build-score-trends.py` — do not hand-edit; regenerate after each ledger row.",
        "",
        "Numbers are per-tag scores as recorded per release (eval sets, channels, and quantization",
        "evolve across eras — adjacent columns are comparable, distant ones directional; the dated",
        "ship-gate docs carry each column's exact conditions). \"—\" = not measured that release.",
        "",
    ]
    for locale in ("us", "fr", "de"):
        tags = [t for t in TAG_ORDER if any(t in s.get(locale, {}) for _, s in rows)]
        extra = sorted({t for _, s in rows for t in s.get(locale, {}) if t not in tags})
        tags += extra
        if not tags:
            continue
        lines.append(f"## {locale.upper()}")
        lines.append("")
        lines.append("| tag | " + " | ".join(v for v, _ in rows) + " |")
        lines.append("| --- |" + " --: |" * len(rows))
        for t in tags:
            cells = []
            for _, s in rows:
                v = s.get(locale, {}).get(t)
                cells.append(f"{v:g}" if v is not None else "—")
            lines.append(f"| {t} | " + " | ".join(cells) + " |")
        lines.append("")
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT} ({len(rows)} versions)")


if __name__ == "__main__":
    main()
