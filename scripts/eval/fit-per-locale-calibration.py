#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Per-locale calibration (#368 L2). The single global isotonic table (fit-isotonic-calibration.py) under-
serves the OOD locales: the per-locale ECE breakdown showed DE/NL run far higher than the US/FR-dominated
global number, and the global map even over-corrects already-well-calibrated subgroups. This fits a
SEPARATE isotonic table per locale and reports, on each locale's held-out split, the ECE under three
regimes: raw softmax, the global table, and the locale-specific table. If the per-locale table beats the
global table on DE/NL, per-locale calibration is the right shape for a multi-locale model.

Consumes the same `(conf, correct, tag, country)` pairs from collect-span-confidences.ts.

Usage:
  python3 scripts/eval/fit-per-locale-calibration.py \
    --conf data/eval/calibration/confidences.jsonl \
    --out data/eval/calibration/isotonic-per-locale-en-us-v4.0.0.json \
    --report docs/articles/evals/2026-06-07-per-locale-calibration.md
"""

import argparse
import json
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]


def pava(y, w):
    sums, wts, cnts = [], [], []
    for yi, wi in zip(y, w):
        sums.append(float(yi) * float(wi))
        wts.append(float(wi))
        cnts.append(1)
        while len(sums) >= 2 and sums[-2] / wts[-2] > sums[-1] / wts[-1]:
            s = sums.pop() + sums[-1]
            wt = wts.pop() + wts[-1]
            c = cnts.pop() + cnts[-1]
            sums[-1], wts[-1], cnts[-1] = s, wt, c
    out = np.empty(int(sum(cnts)))
    pos = 0
    for s, wt, c in zip(sums, wts, cnts):
        out[pos : pos + c] = s / wt
        pos += c
    return out


def fit_isotonic(conf, correct):
    order = np.argsort(conf, kind="mergesort")
    return conf[order], pava(correct[order].astype(float), np.ones(len(order)))


def calibrate(x, xs, g):
    return np.interp(x, xs, g)


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


def table_from_fit(xs, g, bins=20):
    edges = np.linspace(0.0, 1.0, bins + 1)
    centers = (edges[:-1] + edges[1:]) / 2
    cal = calibrate(centers, xs, g)
    return [
        {"lo": float(edges[i]), "hi": float(edges[i + 1]), "center": float(centers[i]), "calibrated": float(cal[i])}
        for i in range(bins)
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", default=str(REPO / "data/eval/calibration/confidences.jsonl"))
    ap.add_argument("--out", default=str(REPO / "data/eval/calibration/isotonic-per-locale-en-us-v4.0.0.json"))
    ap.add_argument("--report", default=str(REPO / "docs/articles/evals/2026-06-07-per-locale-calibration.md"))
    ap.add_argument("--seed", type=int, default=20260607)
    ap.add_argument("--model-version", default="4.0.0")
    args = ap.parse_args()

    recs = [json.loads(l) for l in Path(args.conf).read_text().splitlines() if l.strip()]
    conf = np.array([r["conf"] for r in recs], dtype=float)
    correct = np.array([1.0 if r["correct"] else 0.0 for r in recs], dtype=float)
    country = np.array([r["country"] for r in recs])

    rng = np.random.default_rng(args.seed)

    # Global table: fit on ALL fit-split data (mirrors the shipped global calibrator).
    perm = rng.permutation(len(recs))
    n_eval = len(recs) // 5
    g_eval, g_fit = perm[:n_eval], perm[n_eval:]
    gxs, gg = fit_isotonic(conf[g_fit], correct[g_fit])

    locales = sorted(set(country.tolist()))
    out_tables = {}
    rows = []
    for loc in locales:
        idx = np.where(country == loc)[0]
        if len(idx) < 200:
            continue
        # Per-locale 80/20 split (seeded per locale for stability).
        lrng = np.random.default_rng(args.seed + hash(loc) % 1000)
        lperm = lrng.permutation(len(idx))
        ln_eval = max(40, len(idx) // 5)
        l_eval = idx[lperm[:ln_eval]]
        l_fit = idx[lperm[ln_eval:]]
        lxs, lg = fit_isotonic(conf[l_fit], correct[l_fit])
        out_tables[loc] = table_from_fit(lxs, lg)
        # Evaluate the locale's held-out under three regimes.
        ev_c, ev_y = conf[l_eval], correct[l_eval]
        e_raw = ece(ev_c, ev_y)
        e_global = ece(calibrate(ev_c, gxs, gg), ev_y)
        e_local = ece(calibrate(ev_c, lxs, lg), ev_y)
        rows.append({"locale": loc, "n_eval": int(len(l_eval)), "acc": float(ev_y.mean()),
                     "ece_raw": e_raw, "ece_global": e_global, "ece_local": e_local})

    Path(args.out).write_text(json.dumps({"model": "neural-weights-en-us", "model_version": args.model_version,
                                          "method": "per-locale isotonic (PAVA)", "tables": out_tables}, indent=2) + "\n")

    lines = [f"# Per-locale confidence calibration — en-us v{args.model_version} (#368 L2)", ""]
    lines.append("A separate isotonic table per locale, vs the single global table. ECE is measured on each "
                 "locale's held-out split under three regimes: raw softmax, the global table, the locale table.")
    lines.append("")
    lines.append("| locale | n | accuracy | ECE raw | ECE global-table | ECE locale-table |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
    for r in sorted(rows, key=lambda r: -r["ece_raw"]):
        lines.append(f"| {r['locale']} | {r['n_eval']} | {r['acc']:.3f} | {r['ece_raw']:.4f} | "
                     f"{r['ece_global']:.4f} | **{r['ece_local']:.4f}** |")
    lines.append("")
    lines.append("> Where the locale-table column beats the global-table column, a single global table is "
                 "leaving calibration error on the table for that locale (the OOD locales especially). A "
                 "multi-locale model should ship one calibration table per locale, selected by the locale gate.")
    lines.append("")
    Path(args.report).write_text("\n".join(lines) + "\n")

    print(f"wrote {len(out_tables)} per-locale tables → {args.out}")
    for r in sorted(rows, key=lambda r: -r["ece_raw"]):
        print(f"  {r['locale']}: raw {r['ece_raw']:.4f} | global {r['ece_global']:.4f} | local {r['ece_local']:.4f}  (n={r['n_eval']})")


if __name__ == "__main__":
    main()
