#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Split-conformal coordinate intervals over resolved localities (#374, resolved-coordinate variant).

Beyond the ECE point-calibration shipped in #59, this gives a coverage GUARANTEE on WHERE the address
is: a radius R(α) around the resolved locality centroid that contains the true point with marginal
probability ≥ 1−α. Split conformal, no distributional assumption — the only inputs are per-row
nonconformity scores (Haversine from the gold point to the resolved centroid) and a held-out split.

Method (split conformal regression):
  1. nonconformity score sᵢ = haversine(gold, resolved_centroid) for every RESOLVED row.
  2. split scores into calibration / test (seeded).
  3. for level α: R(α) = the ⌈(1−α)(n_cal+1)⌉-th smallest calibration score (the conformal quantile;
     guarantees marginal coverage ≥ 1−α). If that rank exceeds n_cal, R = ∞ (can't guarantee at this α).
  4. realized coverage = fraction of TEST scores ≤ R(α) — should land near 1−α.

Coverage is CONDITIONAL on the resolver making a prediction: unresolved rows (no locality id) are
abstentions, reported separately as an abstention rate (the resolver declining to place, e.g. the Berlin
city-state rows). The guarantee is "when we DO place a locality, the truth is within R km with prob ≥ 1−α".

The resolved centroid is the locality CENTROID, so R legitimately runs tens of km for edge addresses —
that's the honest size of "we know the city, not the doorstep". The demo can draw R(α) as a circle.

Usage:
  python3 scripts/eval/conformal-coord.py --dump /tmp/resolved-de-v094.json --label DE [--out-json …]
  python3 scripts/eval/conformal-coord.py --self-test
"""

import argparse
import json
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p = math.pi / 180.0
    dlat = (lat2 - lat1) * p
    dlon = (lon2 - lon1) * p
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def conformal_radius(cal_scores, alpha):
    """The ⌈(1−α)(n+1)⌉-th smallest calibration score. math.inf when the rank exceeds n (α too small)."""
    n = len(cal_scores)
    if n == 0:
        return math.inf
    rank = math.ceil((1 - alpha) * (n + 1))
    if rank > n:
        return math.inf
    return sorted(cal_scores)[rank - 1]


def evaluate(scores, alphas, seed, cal_frac):
    """Deterministic shuffle (seeded LCG, no numpy needed), split, conformal radius + realized coverage."""
    idx = list(range(len(scores)))
    # Tiny seeded LCG shuffle — keeps the split reproducible without importing numpy/random-as-global.
    state = (seed * 2654435761 + 1) & 0xFFFFFFFF
    for i in range(len(idx) - 1, 0, -1):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        j = state % (i + 1)
        idx[i], idx[j] = idx[j], idx[i]
    shuffled = [scores[i] for i in idx]
    n_cal = int(len(shuffled) * cal_frac)
    cal, test = shuffled[:n_cal], shuffled[n_cal:]
    rows = []
    for a in alphas:
        r = conformal_radius(cal, a)
        cov = (sum(1 for s in test if s <= r) / len(test)) if test else float("nan")
        rows.append({"alpha": a, "target_coverage": 1 - a, "radius_km": r, "realized_coverage": cov,
                     "n_cal": len(cal), "n_test": len(test)})
    return rows


def load_scores(dump_path, db_path):
    """Per resolved row: haversine(gold, resolved-locality centroid). Returns (scores, n_total, n_abstain)."""
    from sqlite3 import connect

    data = json.loads(Path(dump_path).read_text())
    rows = data if isinstance(data, list) else data.get("resolved", data.get("rows", []))
    db = connect(db_path)
    cur = db.cursor()
    centroid_cache = {}

    def centroid(pid):
        if pid not in centroid_cache:
            row = cur.execute("SELECT latitude, longitude FROM spr WHERE id = ?", (pid,)).fetchone()
            centroid_cache[pid] = row
        return centroid_cache[pid]

    scores, n_abstain = [], 0
    for r in rows:
        pid = r.get("neuralLocId")
        if pid is None:
            n_abstain += 1
            continue
        c = centroid(pid)
        if not c or c[0] is None or r.get("lat") is None:
            n_abstain += 1
            continue
        scores.append(haversine_km(r["lat"], r["lon"], c[0], c[1]))
    db.close()
    return scores, len(rows), n_abstain


def render(label, rows, n_total, n_abstain):
    out = ["", f"Split-conformal coordinate intervals — {label}  (#374)", "-" * 62,
           f"resolved {n_total - n_abstain}/{n_total}  ·  abstained {n_abstain} ({100*n_abstain/max(n_total,1):.1f}%)",
           f"{'target':>7} {'radius (km)':>13} {'realized':>10} {'n_cal':>7} {'n_test':>7}"]
    for r in rows:
        rad = "∞" if r["radius_km"] == math.inf else f"{r['radius_km']:.2f}"
        out.append(f"{r['target_coverage']:>7.2f} {rad:>13} {r['realized_coverage']:>10.3f} "
                   f"{r['n_cal']:>7} {r['n_test']:>7}")
    return "\n".join(out)


def run_self_test():
    # Synthetic nonconformity: exponential-ish via a seeded LCG, so realized coverage must track 1−α.
    scores, state = [], 42
    for _ in range(4000):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        u = (state % 1_000_000) / 1_000_000 or 1e-6
        scores.append(-20.0 * math.log(u))  # mean ~20 km
    alphas = [0.05, 0.1, 0.2]
    rows = evaluate(scores, alphas, seed=7, cal_frac=0.5)
    print(render("self-test (synthetic)", rows, len(scores), 0))
    ok = all(abs(r["realized_coverage"] - r["target_coverage"]) < 0.03 for r in rows)
    print("\nself-test:", "PASS" if ok else "FAIL (coverage strayed >0.03 from target)")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="Split-conformal coordinate intervals (#374)")
    ap.add_argument("--dump", type=Path, help="resolved-rows JSON from oa-resolver-eval --out-resolved")
    ap.add_argument("--db", default=DEFAULT_DB, help="admin gazetteer (spr table) for resolved centroids")
    ap.add_argument("--label", default="dump")
    ap.add_argument("--alphas", default="0.05,0.1,0.2")
    ap.add_argument("--seed", type=int, default=20260607)
    ap.add_argument("--cal-frac", type=float, default=0.5)
    ap.add_argument("--out-json", type=Path)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return run_self_test()
    if not args.dump:
        ap.error("--dump is required (or pass --self-test)")

    alphas = [float(a) for a in args.alphas.split(",")]
    scores, n_total, n_abstain = load_scores(args.dump, args.db)
    if not scores:
        print("no resolved rows with centroids — nothing to calibrate", file=sys.stderr)
        return 1
    rows = evaluate(scores, alphas, args.seed, args.cal_frac)
    print(render(args.label, rows, n_total, n_abstain))
    if args.out_json:
        args.out_json.write_text(json.dumps(
            {"label": args.label, "n_total": n_total, "n_abstain": n_abstain,
             "abstain_rate": n_abstain / max(n_total, 1), "intervals": rows}, indent=2))
        print(f"\nwrote {args.out_json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
