#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Stage 3 of the confidence-calibration pipeline (task #59). Fits an isotonic-regression calibrator on
the (raw span confidence, correct?) pairs from `collect-span-confidences.ts`, emits a 20-bin lookup
table, and reports Expected Calibration Error (ECE) before/after on a HELD-OUT eval split.

Isotonic, not Platt: the model's miscalibration isn't a clean sigmoid (it's overconfident in some
bands, underconfident in others), so a monotone non-parametric fit is the right tool. We implement
the Pool-Adjacent-Violators algorithm (PAVA) directly in numpy — ~15 lines, fully auditable, and it
keeps scikit-learn out of the corpus-python deps for one lookup table.

Honesty guardrails baked in:
  - 80/20 fit/eval split (seeded). The 20-bin table is fit on the 80%; every ECE number is measured
    on the 20% the fit never saw — in-sample ECE would flatter the calibrator.
  - A SEPARATE OA-only eval ECE. The corpus half is in-domain (the model trained on it) so its
    confidence runs optimistically high; the OA half is genuinely held-out real addresses. The
    OA-only number is the trustworthy headline; the combined number is the deliverable's metric.

The output table is consumed by the opt-in decoder calibrator (`core/decoder/calibration.ts`).

Usage:
  python3 scripts/eval/fit-isotonic-calibration.py \
    --conf data/eval/calibration/confidences.jsonl \
    --out data/eval/calibration/isotonic-en-us-v4.0.0.json \
    --report docs/articles/evals/2026-06-07-isotonic-calibration.md \
    [--bins 20 --ece-bins 15 --seed 20260607 --model neural-weights-en-us --model-version 4.0.0]
"""

import argparse
import json
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]


def pava(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Pool-Adjacent-Violators: weighted isotonic (non-decreasing) least-squares fit of `y`."""
    # Each block: [weighted_sum, weight, count]. Merge a new point left while it violates monotonicity.
    sums: list[float] = []
    wts: list[float] = []
    cnts: list[int] = []
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


def fit_isotonic(conf: np.ndarray, correct: np.ndarray):
    """Return (x_sorted, g) — the isotonic step function over confidence. Evaluate via np.interp."""
    order = np.argsort(conf, kind="mergesort")
    xs = conf[order]
    ys = correct[order].astype(float)
    g = pava(ys, np.ones_like(ys))
    return xs, g


def calibrate(x: np.ndarray, xs: np.ndarray, g: np.ndarray) -> np.ndarray:
    """Apply the isotonic fit to confidences `x` (clamped to the fit range by np.interp)."""
    return np.interp(x, xs, g)


def ece(conf: np.ndarray, correct: np.ndarray, n_bins: int) -> tuple[float, float, list[dict]]:
    """Expected + Max Calibration Error over equal-width bins. Returns (ECE, MCE, per-bin rows)."""
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    n = len(conf)
    e = 0.0
    mce = 0.0
    rows = []
    for b in range(n_bins):
        lo, hi = edges[b], edges[b + 1]
        sel = (conf >= lo) & (conf < hi) if b < n_bins - 1 else (conf >= lo) & (conf <= hi)
        nb = int(sel.sum())
        if nb == 0:
            rows.append({"lo": float(lo), "hi": float(hi), "n": 0, "conf": None, "acc": None})
            continue
        cb = float(conf[sel].mean())
        ab = float(correct[sel].mean())
        gap = abs(cb - ab)
        e += (nb / n) * gap
        mce = max(mce, gap)
        rows.append({"lo": float(lo), "hi": float(hi), "n": nb, "conf": cb, "acc": ab})
    return e, mce, rows


def robust_mce(rows: list[dict], min_n: int = 20) -> float:
    """Max calibration error over bins with at least `min_n` samples — equal-width MCE is otherwise
    dominated by single-sample sparse bins (especially post-isotonic, where calibrated values cluster)."""
    gaps = [abs(r["conf"] - r["acc"]) for r in rows if r["n"] >= min_n and r["conf"] is not None]
    return max(gaps) if gaps else 0.0


def brier(conf: np.ndarray, correct: np.ndarray) -> float:
    return float(np.mean((conf - correct) ** 2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", default=str(REPO / "data/eval/calibration/confidences.jsonl"))
    ap.add_argument("--out", default=str(REPO / "data/eval/calibration/isotonic-en-us-v4.0.0.json"))
    ap.add_argument("--report", default=str(REPO / "docs/articles/evals/2026-06-07-isotonic-calibration.md"))
    ap.add_argument("--bins", type=int, default=20, help="lookup-table bins")
    ap.add_argument("--ece-bins", type=int, default=15, help="bins for ECE measurement")
    ap.add_argument("--seed", type=int, default=20260607)
    ap.add_argument("--model", default="neural-weights-en-us")
    ap.add_argument("--model-version", default="4.0.0")
    args = ap.parse_args()

    recs = [json.loads(l) for l in Path(args.conf).read_text().splitlines() if l.strip()]
    conf = np.array([r["conf"] for r in recs], dtype=float)
    correct = np.array([1.0 if r["correct"] else 0.0 for r in recs], dtype=float)
    source = np.array([r["source"] for r in recs])
    tag = np.array([r["tag"] for r in recs])
    country = np.array([r["country"] for r in recs])

    # 80/20 fit/eval split (seeded).
    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(recs))
    n_eval = len(recs) // 5
    eval_idx = perm[:n_eval]
    fit_idx = perm[n_eval:]

    xs, g = fit_isotonic(conf[fit_idx], correct[fit_idx])

    # 20-bin lookup table: calibrated value at each bin CENTER.
    edges = np.linspace(0.0, 1.0, args.bins + 1)
    centers = (edges[:-1] + edges[1:]) / 2
    cal_centers = calibrate(centers, xs, g)
    table = [
        {"lo": float(edges[i]), "hi": float(edges[i + 1]), "center": float(centers[i]), "calibrated": float(cal_centers[i])}
        for i in range(args.bins)
    ]

    # ECE before/after on the held-out eval split.
    ev_conf, ev_correct, ev_src = conf[eval_idx], correct[eval_idx], source[eval_idx]
    ev_cal = calibrate(ev_conf, xs, g)
    ece_raw, mce_raw, rel_raw = ece(ev_conf, ev_correct, args.ece_bins)
    ece_cal, mce_cal, rel_cal = ece(ev_cal, ev_correct, args.ece_bins)

    # OA-only eval (genuinely held-out real addresses — the trustworthy headline).
    oa = ev_src == "oa"
    ece_raw_oa, _, _ = ece(ev_conf[oa], ev_correct[oa], args.ece_bins)
    ece_cal_oa, _, _ = ece(ev_cal[oa], ev_correct[oa], args.ece_bins)
    co = ev_src == "corpus"
    ece_raw_co, _, _ = ece(ev_conf[co], ev_correct[co], args.ece_bins)
    ece_cal_co, _, _ = ece(ev_cal[co], ev_correct[co], args.ece_bins)

    # Per-tag + per-locale ECE on the eval split (#368 S1). The global ECE masks where the model is
    # mis-calibrated; a subgroup needs >=100 eval spans to report (else the ECE is bin noise).
    ev_tag, ev_country = tag[eval_idx], country[eval_idx]

    def group_ece(keys):
        out = {}
        for k in sorted(set(keys.tolist())):
            m = keys == k
            if int(m.sum()) < 100:
                continue
            e_raw, _, _ = ece(ev_conf[m], ev_correct[m], args.ece_bins)
            e_cal, _, _ = ece(ev_cal[m], ev_correct[m], args.ece_bins)
            out[str(k)] = {"n": int(m.sum()), "acc": float(ev_correct[m].mean()), "ece_raw": e_raw, "ece_cal": e_cal}
        return out

    per_tag = group_ece(ev_tag)
    per_locale = group_ece(ev_country)

    # Abstention curve (#368 S2): precision vs coverage as the accept threshold rises on CALIBRATED
    # confidence — the downstream-routing artifact ("auto-accept above T, review the rest"). Only
    # meaningful once confidence is calibrated, which is why it lives here.
    abstention = []
    for t in [0.5, 0.8, 0.9, 0.95, 0.97]:
        sel = ev_cal >= t
        cov = float(sel.mean())
        prec = float(ev_correct[sel].mean()) if int(sel.sum()) else 0.0
        abstention.append({"threshold": t, "coverage": cov, "precision": prec, "reviewed": 1.0 - cov})

    payload = {
        "model": args.model,
        "model_version": args.model_version,
        "method": "isotonic-regression (PAVA) over per-span softmax confidence",
        "created_from": str(Path(args.conf).relative_to(REPO)),
        "n_total": len(recs),
        "n_fit": int(len(fit_idx)),
        "n_eval": int(len(eval_idx)),
        "bins": args.bins,
        "ece_bins": args.ece_bins,
        "metrics": {
            "ece_raw_eval": ece_raw,
            "ece_cal_eval": ece_cal,
            "mce_raw_eval": robust_mce(rel_raw),
            "mce_cal_eval": robust_mce(rel_cal),
            "mce_raw_eval_allbins": mce_raw,
            "mce_cal_eval_allbins": mce_cal,
            "brier_raw_eval": brier(ev_conf, ev_correct),
            "brier_cal_eval": brier(ev_cal, ev_correct),
            "ece_raw_oa_eval": ece_raw_oa,
            "ece_cal_oa_eval": ece_cal_oa,
            "ece_raw_corpus_eval": ece_raw_co,
            "ece_cal_corpus_eval": ece_cal_co,
        },
        "per_tag_ece": per_tag,
        "per_locale_ece": per_locale,
        "abstention_curve": abstention,
        # Per-bin reliability on the held-out eval split (mean conf vs accuracy per equal-width bin),
        # before + after calibration. The data behind the reliability diagram the demo draws —
        # serialized so the front-end is self-contained (no need to re-derive from the raw conf set).
        "reliability_raw": rel_raw,
        "reliability_cal": rel_cal,
        "table": table,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote calibration table → {out_path}")
    print(f"  ECE eval: raw {ece_raw:.4f} → cal {ece_cal:.4f}   (target <0.05)")
    print(f"  ECE OA-only (held-out): raw {ece_raw_oa:.4f} → cal {ece_cal_oa:.4f}")
    print(f"  ECE corpus-only:        raw {ece_raw_co:.4f} → cal {ece_cal_co:.4f}")
    print(f"  MCE eval (bins n>=20): raw {robust_mce(rel_raw):.4f} → cal {robust_mce(rel_cal):.4f}")
    print(f"  Brier eval: raw {brier(ev_conf, ev_correct):.4f} → cal {brier(ev_cal, ev_correct):.4f}")

    # Self-reported markdown (eval figures must be generated, never hand-typed).
    def fmt(v):
        return f"{v:.3f}" if v is not None else "—"

    lines = []
    lines.append(f"# Isotonic confidence calibration — {args.model} v{args.model_version}")
    lines.append("")
    lines.append(
        "Post-hoc calibration of the decoder's per-span softmax confidence (the `conf=` a resolver or "
        "human reads off the parse). Method: isotonic regression (PAVA) over `(raw confidence, correct?)` "
        "pairs from a 50/50 OpenAddresses + training-corpus calibration set. Fit on 80%, every number below "
        "measured on the held-out 20%. Task #59 (#240 PR3)."
    )
    lines.append("")
    lines.append(
        "> `correct?` is a normalized exact-or-token-subset span match (so street decomposition and "
        "multi-word fragmentation aren't penalized), so the absolute accuracy runs mildly optimistic — "
        "isotonic corrects the reliability *shape*, which the lenient threshold leaves intact. The corpus "
        "half is in-domain (the model trained on it); the OA-only row above is the trustworthy held-out ECE."
    )
    lines.append("")
    lines.append("## Headline")
    lines.append("")
    lines.append("| Split | ECE raw | ECE calibrated | target |")
    lines.append("| --- | --- | --- | --- |")
    # `<0.05` is backtick-wrapped: docs/articles/*.md is MDX, which parses a bare `<` as a JSX tag.
    lines.append(f"| **Combined (deliverable)** | {ece_raw:.4f} | **{ece_cal:.4f}** | `<0.05` |")
    lines.append(f"| OA-only (held-out, trustworthy) | {ece_raw_oa:.4f} | {ece_cal_oa:.4f} | — |")
    lines.append(f"| corpus-only (in-domain) | {ece_raw_co:.4f} | {ece_cal_co:.4f} | — |")
    lines.append("")
    lines.append(f"MCE (bins n≥20) {robust_mce(rel_raw):.4f} → {robust_mce(rel_cal):.4f} · "
                 f"Brier {brier(ev_conf, ev_correct):.4f} → {brier(ev_cal, ev_correct):.4f} · "
                 f"n_fit={len(fit_idx)} n_eval={len(eval_idx)} spans.")
    lines.append("")
    lines.append(
        "> MCE is reported over bins with ≥20 samples. The model is confident — ~94% of held-out spans "
        "sit in [0.93, 1.0] — so equal-width bins below ~0.7 hold a handful of samples each and their "
        "all-bins max gap is single-sample noise, not a calibration failure. ECE (sample-weighted) is the "
        "headline; it weights each bin by its mass."
    )
    lines.append("")

    def reliability_table(title: str, rows: list[dict], label: str) -> None:
        lines.append(f"## Reliability (held-out eval, {title})")
        lines.append("")
        lines.append(f"| confidence bin | n | mean {label} | accuracy | gap |")
        lines.append("| --- | --- | --- | --- | --- |")
        for r in rows:
            if r["n"] == 0:
                continue
            gap = abs(r["conf"] - r["acc"])
            lines.append(f"| [{r['lo']:.2f}, {r['hi']:.2f}) | {r['n']} | {fmt(r['conf'])} | {fmt(r['acc'])} | {gap:.3f} |")
        lines.append("")

    reliability_table("raw confidence", rel_raw, "conf")
    reliability_table("calibrated confidence", rel_cal, "cal")

    def subgroup_table(title: str, groups: dict) -> None:
        lines.append(f"## ECE by {title} (held-out eval, raw → calibrated)")
        lines.append("")
        lines.append(f"| {title} | n | accuracy | ECE raw | ECE calibrated |")
        lines.append("| --- | ---: | ---: | ---: | ---: |")
        for k, v in sorted(groups.items(), key=lambda kv: -kv[1]["ece_raw"]):
            lines.append(f"| {k} | {v['n']} | {v['acc']:.3f} | {v['ece_raw']:.4f} | {v['ece_cal']:.4f} |")
        lines.append("")

    subgroup_table("locale", per_locale)
    subgroup_table("tag", per_tag)
    lines.append("## Abstention curve (calibrated confidence)")
    lines.append("")
    lines.append("Accept spans at or above the threshold; route the rest to review. Precision is the accuracy of the accepted set.")
    lines.append("")
    lines.append("| threshold | coverage (accepted) | precision | reviewed |")
    lines.append("| --- | ---: | ---: | ---: |")
    for a in abstention:
        lines.append(f"| {a['threshold']:.2f} | {100*a['coverage']:.1f}% | {100*a['precision']:.2f}% | {100*a['reviewed']:.1f}% |")
    lines.append("")
    lines.append(
        "> The single global table is fit across all locales/tags, so it under-serves the worst-calibrated "
        "subgroups — the per-locale rows show where the one-size table leaves residual error (the OOD "
        "locales and rare tags run far higher than the US/FR-dominated global ECE). A per-locale table is "
        "the natural next step once the deployed multi-locale model is the calibration target (#368)."
    )
    lines.append("")
    lines.append("## 20-bin lookup table (raw → calibrated)")
    lines.append("")
    lines.append("| bin center | calibrated |")
    lines.append("| --- | --- |")
    for t in table:
        lines.append(f"| {t['center']:.3f} | {t['calibrated']:.3f} |")
    lines.append("")
    lines.append("## How it's wired")
    lines.append("")
    lines.append(
        "The table ships as `data/eval/calibration/isotonic-en-us-v4.0.0.json` and is turned into a "
        "`(raw)=>calibrated` function by the OPT-IN decoder calibrator (`core/decoder/calibration.ts` → "
        "`createCalibrator`). Default parse output is unchanged (byte-stable); pass the calibrator via "
        "`ParseOpts.calibrate` / `BuildTreeOpts.calibrate` to emit calibrated `conf=`. Regenerate with "
        "`scripts/eval/{build-calibration-set.py,collect-span-confidences.ts,fit-isotonic-calibration.py}`."
    )
    lines.append("")
    rep_path = Path(args.report)
    rep_path.parent.mkdir(parents=True, exist_ok=True)
    rep_path.write_text("\n".join(lines) + "\n")
    print(f"wrote report → {rep_path}")


if __name__ == "__main__":
    main()
