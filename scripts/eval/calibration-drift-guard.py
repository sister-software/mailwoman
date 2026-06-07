#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Calibration drift guard (#368 S6). A shipped calibration table (isotonic-<locale>-<version>.json) records
the held-out ECE it achieved. If the model is swapped or the confidences regenerated and the table is NOT
re-fit, the `conf=` it produces silently drifts out of calibration. This guard re-applies the committed
table to the committed confidences and fails (exit 1) if the held-out calibrated ECE drifts more than
--tolerance from the value recorded in the table — a cheap, CI-friendly tripwire (not a unit test; it
needs the confidences dump, which is regenerated, not committed in full).

Usage:
  python3 scripts/eval/calibration-drift-guard.py \
    --table data/eval/calibration/isotonic-en-us-v4.0.0.json \
    --conf data/eval/calibration/confidences.jsonl [--tolerance 0.02 --seed 20260607]
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]


def ece(conf, correct, n_bins=15):
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    n = len(conf)
    if n == 0:
        return 0.0
    e = 0.0
    for b in range(n_bins):
        lo, hi = edges[b], edges[b + 1]
        sel = (conf >= lo) & (conf < hi) if b < n_bins - 1 else (conf >= lo) & (conf <= hi)
        if int(sel.sum()) == 0:
            continue
        e += (int(sel.sum()) / n) * abs(float(conf[sel].mean()) - float(correct[sel].mean()))
    return e


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", default=str(REPO / "data/eval/calibration/isotonic-en-us-v4.0.0.json"))
    ap.add_argument("--conf", default=str(REPO / "data/eval/calibration/confidences.jsonl"))
    ap.add_argument("--tolerance", type=float, default=0.02)
    ap.add_argument("--seed", type=int, default=20260607)
    args = ap.parse_args()

    table = json.loads(Path(args.table).read_text())
    recorded = table.get("metrics", {}).get("ece_cal_eval")
    if recorded is None:
        print(f"DRIFT-GUARD: table {args.table} has no metrics.ece_cal_eval — cannot check", file=sys.stderr)
        return 2

    bins = sorted(table["table"], key=lambda b: b["center"])
    centers = np.array([b["center"] for b in bins])
    cals = np.array([b["calibrated"] for b in bins])

    recs = [json.loads(l) for l in Path(args.conf).read_text().splitlines() if l.strip()]
    conf = np.array([r["conf"] for r in recs], dtype=float)
    correct = np.array([1.0 if r["correct"] else 0.0 for r in recs], dtype=float)

    # Same held-out 20% the fitter measures on (seeded), so the comparison is apples-to-apples.
    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(recs))
    ev = perm[: len(recs) // 5]
    ev_cal = np.interp(conf[ev], centers, cals)
    observed = ece(ev_cal, correct[ev])

    drift = abs(observed - recorded)
    ok = drift <= args.tolerance
    status = "OK" if ok else "DRIFT"
    print(f"[{status}] calibrated ECE: recorded {recorded:.4f} vs observed {observed:.4f} "
          f"(drift {drift:.4f}, tolerance {args.tolerance})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
