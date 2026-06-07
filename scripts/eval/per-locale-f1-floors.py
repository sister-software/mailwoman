#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Per-locale F1 floor gate (#375 S48). Reads the `--out-json` written by `scripts/eval/per-locale-f1.ts`
({ reports: FileReport[], spread }) and checks each locale's micro-F1 against a minimum floor. The point
is discipline: "beat Pelias" and a healthy AGGREGATE F1 can hide a single locale rotting, because the
US-heavy golden set dominates the mean (see project-per-locale-f1-baseline). A per-locale floor turns
each locale into its own tripwire — add a locale, or regress an existing one below its floor, and this
surfaces it by name.

NON-BLOCKING by default: it prints a table and exits 0 even on a breach, so it can ride along in CI as a
visible signal without gating merges. Pass --blocking to make a breach exit 1 (for a dedicated guard job).

Floors are REGRESSION floors — set a few points UNDER each locale's established baseline, so the gate
fires on a real drop, not on normal noise. Seeded from the per-locale-f1 baseline (US micro ~0.82, FR
~0.66). Locales without a measured baseline are left null (SKIP) rather than guessed — DE in particular
waits on the model-path fix (#397) before a parser-F1 floor can be set honestly.

Usage:
  node --experimental-strip-types scripts/eval/per-locale-f1.ts ... --out-json /tmp/plf1.json
  python3 scripts/eval/per-locale-f1-floors.py --report /tmp/plf1.json [--floors floors.json --blocking]
  python3 scripts/eval/per-locale-f1-floors.py --self-test
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# locale key -> minimum acceptable micro-F1 (regression floor). null = no floor yet (SKIP, not guessed).
DEFAULT_FLOORS: dict[str, float | None] = {
    "us": 0.80,  # baseline canonical micro ~0.82 → floor a couple points under
    "fr": 0.64,  # baseline canonical micro ~0.66
    "de": None,  # pending #397 (model path) before a parser-F1 floor is honest
    "es": None,
    "it": None,
    "nl": None,
}

# Substrings that map a golden FILE name to a locale key. Tried longest-first so "en-us" wins over "us".
FILE_ALIASES: dict[str, str] = {
    "en-us": "us",
    "fr-fr": "fr",
    "de-de": "de",
    "es-es": "es",
    "it-it": "it",
    "nl-nl": "nl",
    "us": "us",
    "fr": "fr",
    "de": "de",
    "es": "es",
    "it": "it",
    "nl": "nl",
}


def locale_of(file_name: str) -> str | None:
    # Match against the extension-stripped stem, on alphanumeric word boundaries — otherwise EVERY
    # `.jsonl` file matches "nl" (it lives inside "jso-NL"), which the self-test caught. Longest alias
    # first so "en-us" wins over "us".
    stem = re.sub(r"\.[a-z0-9]+$", "", file_name.lower())
    for alias in sorted(FILE_ALIASES, key=len, reverse=True):
        if re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", stem):
            return FILE_ALIASES[alias]
    return None


def evaluate(reports: list[dict], floors: dict[str, float | None]) -> list[dict]:
    """One row per report: locale, micro-F1, floor, status (PASS / BELOW / SKIP / UNKNOWN_LOCALE)."""
    rows = []
    for r in reports:
        file_name = r.get("file", "?")
        micro = float(r.get("microF1", 0.0))
        loc = locale_of(file_name)
        if loc is None:
            status, floor = "UNKNOWN_LOCALE", None
        else:
            floor = floors.get(loc)
            if floor is None:
                status = "SKIP"
            else:
                status = "PASS" if micro >= floor else "BELOW"
        rows.append({"file": file_name, "locale": loc, "microF1": micro, "floor": floor, "status": status})
    return rows


def render(rows: list[dict]) -> str:
    out = ["", "Per-locale F1 floor gate (#375)", "-" * 60,
           f"{'file':<26} {'locale':<7} {'micro-F1':>9} {'floor':>7}  status"]
    for r in rows:
        floor = f"{r['floor']:.3f}" if r["floor"] is not None else "  —  "
        out.append(f"{r['file']:<26} {(r['locale'] or '?'):<7} {r['microF1']:>9.3f} {floor:>7}  {r['status']}")
    return "\n".join(out)


def run_self_test() -> int:
    fixture = {
        "reports": [
            {"file": "canonical-en-us.jsonl", "microF1": 0.83},  # PASS (>= 0.80)
            {"file": "canonical-fr-fr.jsonl", "microF1": 0.60},  # BELOW (< 0.64)
            {"file": "canonical-de-de.jsonl", "microF1": 0.70},  # SKIP (no floor)
            {"file": "mystery-xx.jsonl", "microF1": 0.50},       # UNKNOWN_LOCALE
        ]
    }
    rows = evaluate(fixture["reports"], DEFAULT_FLOORS)
    got = {r["file"]: r["status"] for r in rows}
    expected = {
        "canonical-en-us.jsonl": "PASS",
        "canonical-fr-fr.jsonl": "BELOW",
        "canonical-de-de.jsonl": "SKIP",
        "mystery-xx.jsonl": "UNKNOWN_LOCALE",
    }
    print(render(rows))
    ok = got == expected
    print("\nself-test:", "PASS" if ok else f"FAIL got={got} expected={expected}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Per-locale F1 floor gate (#375 S48)")
    ap.add_argument("--report", type=Path, help="per-locale-f1.ts --out-json output")
    ap.add_argument("--floors", type=Path, help="JSON {locale: minMicroF1|null}; overrides built-in defaults")
    ap.add_argument("--blocking", action="store_true", help="exit 1 on any BELOW (default: non-blocking, exit 0)")
    ap.add_argument("--self-test", action="store_true", help="run the built-in fixture self-test and exit")
    args = ap.parse_args()

    if args.self_test:
        return run_self_test()
    if not args.report:
        ap.error("--report is required (or pass --self-test)")

    floors = DEFAULT_FLOORS
    if args.floors:
        floors = {**DEFAULT_FLOORS, **json.loads(args.floors.read_text())}

    data = json.loads(args.report.read_text())
    reports = data.get("reports", data if isinstance(data, list) else [])
    rows = evaluate(reports, floors)
    print(render(rows))

    below = [r for r in rows if r["status"] == "BELOW"]
    if below:
        names = ", ".join(f"{r['locale']} ({r['microF1']:.3f} < {r['floor']:.3f})" for r in below)
        print(f"\n⚠ {len(below)} locale(s) below floor: {names}", file=sys.stderr)
        if args.blocking:
            return 1
    else:
        print("\n✓ all floored locales at or above their floor", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
