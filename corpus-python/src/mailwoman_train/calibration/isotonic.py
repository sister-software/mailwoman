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
  python -m mailwoman_train.calibration.isotonic \
    --conf data/eval/calibration/confidences.jsonl \
    --out data/eval/calibration/isotonic-en-us-v4.0.0.json \
    --report docs/articles/evals/calibration/2026-06-07-isotonic-calibration.md \
    [--bins 20 --ece-bins 15 --seed 20260607 --model neural-weights-en-us --model-version 4.0.0]
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..paths import repo_root_path

REPO = repo_root_path()

#: A subgroup needs this many held-out spans before its ECE is reported. Below it the figure is bin
#: noise, and the global ECE it would be compared against is not.
MIN_SUBGROUP_SPANS = 100

#: The accept thresholds the abstention curve reports, as calibrated confidence.
ABSTENTION_THRESHOLDS = (0.5, 0.8, 0.9, 0.95, 0.97)


def pava(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Pool-Adjacent-Violators: weighted isotonic (non-decreasing) least-squares fit of `y`."""
    # Each block: [weighted_sum, weight, count]. Merge a new point left while it violates monotonicity.
    sums: list[float] = []
    wts: list[float] = []
    cnts: list[int] = []
    for yi, wi in zip(y, w, strict=False):
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
    for s, wt, c in zip(sums, wts, cnts, strict=False):
        out[pos : pos + c] = s / wt
        pos += c
    return out


def fit_isotonic(conf: np.ndarray, correct: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (x_sorted, g) — the isotonic step function over confidence. Evaluate via np.interp."""
    order = np.argsort(conf, kind="mergesort")
    xs = conf[order]
    ys = correct[order].astype(float)
    g = pava(ys, np.ones_like(ys))
    return xs, g


def calibrate(x: np.ndarray, xs: np.ndarray, g: np.ndarray) -> np.ndarray:
    """Apply the isotonic fit to confidences `x` (clamped to the fit range by np.interp)."""
    calibrated: np.ndarray = np.interp(x, xs, g)
    return calibrated


def ece(conf: np.ndarray, correct: np.ndarray, n_bins: int) -> tuple[float, float, list[dict[str, Any]]]:
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


def robust_mce(rows: list[dict[str, Any]], min_n: int = 20) -> float:
    """Max calibration error over bins with at least `min_n` samples — equal-width MCE is otherwise
    dominated by single-sample sparse bins (especially post-isotonic, where calibrated values cluster)."""
    gaps = [abs(r["conf"] - r["acc"]) for r in rows if r["n"] >= min_n and r["conf"] is not None]
    return max(gaps) if gaps else 0.0


def brier(conf: np.ndarray, correct: np.ndarray) -> float:
    return float(np.mean((conf - correct) ** 2))


def provenance_path(path: Path) -> str:
    """How the emitted table names the confidence set it was fit on.

    Repository-relative where that is meaningful, absolute otherwise. `relative_to` RAISES on a
    path outside the checkout, and it is read after the fit, so an input elsewhere on disk used to
    lose the whole run to a ValueError at the serialization step.
    """
    return str(path.relative_to(REPO)) if path.is_relative_to(REPO) else str(path)


@dataclass(frozen=True)
class Fit:
    """One isotonic fit and every figure measured from it.

    Every number the table and the report carry is computed once, here. They used to be derived
    twice — once into the payload, once into the markdown — and a report that recomputes its own
    figures can disagree with the table it ships beside.
    """

    n_total: int
    n_fit: int
    n_eval: int
    table: list[dict[str, Any]]
    metrics: dict[str, float]
    per_tag: dict[str, dict[str, Any]]
    per_locale: dict[str, dict[str, Any]]
    abstention: list[dict[str, Any]]
    reliability_raw: list[dict[str, Any]]
    reliability_cal: list[dict[str, Any]]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", default=str(REPO / "data/eval/calibration/confidences.jsonl"))
    ap.add_argument("--out", default=str(REPO / "data/eval/calibration/isotonic-en-us-v4.0.0.json"))
    ap.add_argument(
        "--report", default=str(REPO / "docs/articles/evals/calibration/2026-06-07-isotonic-calibration.md")
    )
    ap.add_argument("--bins", type=int, default=20, help="lookup-table bins")
    ap.add_argument("--ece-bins", type=int, default=15, help="bins for ECE measurement")
    ap.add_argument("--seed", type=int, default=20260607)
    ap.add_argument("--model", default="neural-weights-en-us")
    ap.add_argument("--model-version", default="4.0.0")
    return ap.parse_args(argv)


def lookup_table(xs: np.ndarray, g: np.ndarray, bins: int) -> list[dict[str, Any]]:
    """The shipped table: the calibrated value at each equal-width bin's CENTER."""
    edges = np.linspace(0.0, 1.0, bins + 1)
    centers = (edges[:-1] + edges[1:]) / 2
    cal_centers = calibrate(centers, xs, g)
    return [
        {
            "lo": float(edges[i]),
            "hi": float(edges[i + 1]),
            "center": float(centers[i]),
            "calibrated": float(cal_centers[i]),
        }
        for i in range(bins)
    ]


def subgroup_ece(
    keys: np.ndarray, ev_conf: np.ndarray, ev_cal: np.ndarray, ev_correct: np.ndarray, ece_bins: int
) -> dict[str, dict[str, Any]]:
    """Per-key ECE on the eval split (#368 S1).

    The global ECE masks WHERE the model is mis-calibrated, which is what a single global table
    then under-serves. A key under `MIN_SUBGROUP_SPANS` is omitted rather than reported small.
    """
    out: dict[str, dict[str, Any]] = {}
    for k in sorted(set(keys.tolist())):
        m = keys == k
        if int(m.sum()) < MIN_SUBGROUP_SPANS:
            continue
        e_raw, _, _ = ece(ev_conf[m], ev_correct[m], ece_bins)
        e_cal, _, _ = ece(ev_cal[m], ev_correct[m], ece_bins)
        out[str(k)] = {"n": int(m.sum()), "acc": float(ev_correct[m].mean()), "ece_raw": e_raw, "ece_cal": e_cal}
    return out


def abstention_curve(ev_cal: np.ndarray, ev_correct: np.ndarray) -> list[dict[str, Any]]:
    """Precision against coverage as the accept threshold rises (#368 S2).

    The downstream-routing artifact — auto-accept above T, review the rest. It is meaningful only
    once confidence is calibrated, which is why it is measured here and not at the decoder.
    """
    curve = []
    for t in ABSTENTION_THRESHOLDS:
        sel = ev_cal >= t
        cov = float(sel.mean())
        prec = float(ev_correct[sel].mean()) if int(sel.sum()) else 0.0
        curve.append({"threshold": t, "coverage": cov, "precision": prec, "reviewed": 1.0 - cov})
    return curve


def fit_and_measure(records: list[dict[str, Any]], *, bins: int, ece_bins: int, seed: int) -> Fit:
    """Fit on 80% of the records and measure every reported figure on the 20% the fit never saw."""
    conf = np.array([r["conf"] for r in records], dtype=float)
    correct = np.array([1.0 if r["correct"] else 0.0 for r in records], dtype=float)
    source = np.array([r["source"] for r in records])
    tag = np.array([r["tag"] for r in records])
    country = np.array([r["country"] for r in records])

    rng = np.random.default_rng(seed)
    perm = rng.permutation(len(records))
    n_eval = len(records) // 5
    eval_idx = perm[:n_eval]
    fit_idx = perm[n_eval:]

    xs, g = fit_isotonic(conf[fit_idx], correct[fit_idx])

    ev_conf, ev_correct, ev_src = conf[eval_idx], correct[eval_idx], source[eval_idx]
    ev_cal = calibrate(ev_conf, xs, g)
    ece_raw, mce_raw, rel_raw = ece(ev_conf, ev_correct, ece_bins)
    ece_cal, mce_cal, rel_cal = ece(ev_cal, ev_correct, ece_bins)

    # The OA half is genuinely held-out real addresses; the corpus half is in-domain, so its
    # confidence runs optimistically high. Reported apart because averaging them hides that.
    oa = ev_src == "oa"
    ece_raw_oa, _, _ = ece(ev_conf[oa], ev_correct[oa], ece_bins)
    ece_cal_oa, _, _ = ece(ev_cal[oa], ev_correct[oa], ece_bins)
    co = ev_src == "corpus"
    ece_raw_co, _, _ = ece(ev_conf[co], ev_correct[co], ece_bins)
    ece_cal_co, _, _ = ece(ev_cal[co], ev_correct[co], ece_bins)

    return Fit(
        n_total=len(records),
        n_fit=int(len(fit_idx)),
        n_eval=int(len(eval_idx)),
        table=lookup_table(xs, g, bins),
        metrics={
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
        per_tag=subgroup_ece(tag[eval_idx], ev_conf, ev_cal, ev_correct, ece_bins),
        per_locale=subgroup_ece(country[eval_idx], ev_conf, ev_cal, ev_correct, ece_bins),
        abstention=abstention_curve(ev_cal, ev_correct),
        reliability_raw=rel_raw,
        reliability_cal=rel_cal,
    )


def build_payload(args: argparse.Namespace, fit: Fit) -> dict[str, Any]:
    """The shipped table, with the provenance and the figures behind the demo's reliability diagram."""
    return {
        "model": args.model,
        "model_version": args.model_version,
        "method": "isotonic-regression (PAVA) over per-span softmax confidence",
        "created_from": provenance_path(Path(args.conf)),
        "n_total": fit.n_total,
        "n_fit": fit.n_fit,
        "n_eval": fit.n_eval,
        "bins": args.bins,
        "ece_bins": args.ece_bins,
        "metrics": fit.metrics,
        "per_tag_ece": fit.per_tag,
        "per_locale_ece": fit.per_locale,
        "abstention_curve": fit.abstention,
        # Per-bin reliability on the held-out eval split (mean conf vs accuracy per equal-width bin),
        # before + after calibration. The data behind the reliability diagram the demo draws —
        # serialized so the front-end is self-contained (no need to re-derive from the raw conf set).
        "reliability_raw": fit.reliability_raw,
        "reliability_cal": fit.reliability_cal,
        "table": fit.table,
    }


def _fmt(v: float | None) -> str:
    return f"{v:.3f}" if v is not None else "—"


def _headline_lines(args: argparse.Namespace, fit: Fit) -> list[str]:
    m = fit.metrics
    return [
        f"# Isotonic confidence calibration — {args.model} v{args.model_version}",
        "",
        "Post-hoc calibration of the decoder's per-span softmax confidence (the `conf=` a resolver or "
        "human reads off the parse). Method: isotonic regression (PAVA) over `(raw confidence, correct?)` "
        "pairs from a 50/50 OpenAddresses + training-corpus calibration set. Fit on 80%, every number below "
        "measured on the held-out 20%. Task #59 (#240 PR3).",
        "",
        "> `correct?` is a normalized exact-or-token-subset span match (so street decomposition and "
        "multi-word fragmentation aren't penalized), so the absolute accuracy runs mildly optimistic — "
        "isotonic corrects the reliability *shape*, which the lenient threshold leaves intact. The corpus "
        "half is in-domain (the model trained on it); the OA-only row above is the trustworthy held-out ECE.",
        "",
        "## Headline",
        "",
        "| Split | ECE raw | ECE calibrated | target |",
        "| --- | --- | --- | --- |",
        # `<0.05` is backtick-wrapped: docs/articles/*.md is MDX, which parses a bare `<` as a JSX tag.
        f"| **Combined (deliverable)** | {m['ece_raw_eval']:.4f} | **{m['ece_cal_eval']:.4f}** | `<0.05` |",
        f"| OA-only (held-out, trustworthy) | {m['ece_raw_oa_eval']:.4f} | {m['ece_cal_oa_eval']:.4f} | — |",
        f"| corpus-only (in-domain) | {m['ece_raw_corpus_eval']:.4f} | {m['ece_cal_corpus_eval']:.4f} | — |",
        "",
        f"MCE (bins n≥20) {m['mce_raw_eval']:.4f} → {m['mce_cal_eval']:.4f} · "
        f"Brier {m['brier_raw_eval']:.4f} → {m['brier_cal_eval']:.4f} · "
        f"n_fit={fit.n_fit} n_eval={fit.n_eval} spans.",
        "",
        "> MCE is reported over bins with ≥20 samples. The model is confident — ~94% of held-out spans "
        "sit in [0.93, 1.0] — so equal-width bins below ~0.7 hold a handful of samples each and their "
        "all-bins max gap is single-sample noise, not a calibration failure. ECE (sample-weighted) is the "
        "headline; it weights each bin by its mass.",
        "",
    ]


def _reliability_lines(title: str, rows: list[dict[str, Any]], label: str) -> list[str]:
    lines = [
        f"## Reliability (held-out eval, {title})",
        "",
        f"| confidence bin | n | mean {label} | accuracy | gap |",
        "| --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        if r["n"] == 0:
            continue
        gap = abs(r["conf"] - r["acc"])
        lines.append(
            f"| [{r['lo']:.2f}, {r['hi']:.2f}) | {r['n']} | {_fmt(r['conf'])} | {_fmt(r['acc'])} | {gap:.3f} |"
        )
    lines.append("")
    return lines


def _subgroup_lines(title: str, groups: dict[str, dict[str, Any]]) -> list[str]:
    lines = [
        f"## ECE by {title} (held-out eval, raw → calibrated)",
        "",
        f"| {title} | n | accuracy | ECE raw | ECE calibrated |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for k, v in sorted(groups.items(), key=lambda kv: -kv[1]["ece_raw"]):
        lines.append(f"| {k} | {v['n']} | {v['acc']:.3f} | {v['ece_raw']:.4f} | {v['ece_cal']:.4f} |")
    lines.append("")
    return lines


def _abstention_lines(fit: Fit) -> list[str]:
    lines = [
        "## Abstention curve (calibrated confidence)",
        "",
        "Accept spans at or above the threshold; route the rest to review. Precision is the accuracy of the accepted set.",
        "",
        "| threshold | coverage (accepted) | precision | reviewed |",
        "| --- | ---: | ---: | ---: |",
    ]
    for a in fit.abstention:
        lines.append(
            f"| {a['threshold']:.2f} | {100 * a['coverage']:.1f}% | {100 * a['precision']:.2f}% | {100 * a['reviewed']:.1f}% |"
        )
    lines.append("")
    lines.append(
        "> The single global table is fit across all locales/tags, so it under-serves the worst-calibrated "
        "subgroups — the per-locale rows show where the one-size table leaves residual error (the OOD "
        "locales and rare tags run far higher than the US/FR-dominated global ECE). A per-locale table is "
        "the natural next step once the deployed multi-locale model is the calibration target (#368)."
    )
    lines.append("")
    return lines


def _table_lines(fit: Fit) -> list[str]:
    lines = [
        "## 20-bin lookup table (raw → calibrated)",
        "",
        "| bin center | calibrated |",
        "| --- | --- |",
    ]
    for bin_row in fit.table:
        lines.append(f"| {bin_row['center']:.3f} | {bin_row['calibrated']:.3f} |")
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
    return lines


def render_report(args: argparse.Namespace, fit: Fit) -> str:
    """The self-reported markdown. Every figure is read off `fit` — an eval number is never hand-typed."""
    lines = [
        *_headline_lines(args, fit),
        *_reliability_lines("raw confidence", fit.reliability_raw, "conf"),
        *_reliability_lines("calibrated confidence", fit.reliability_cal, "cal"),
        *_subgroup_lines("locale", fit.per_locale),
        *_subgroup_lines("tag", fit.per_tag),
        *_abstention_lines(fit),
        *_table_lines(fit),
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    records = [json.loads(line) for line in Path(args.conf).read_text().splitlines() if line.strip()]
    fit = fit_and_measure(records, bins=args.bins, ece_bins=args.ece_bins, seed=args.seed)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(build_payload(args, fit), indent=2) + "\n")
    m = fit.metrics
    print(f"wrote calibration table → {out_path}")
    print(f"  ECE eval: raw {m['ece_raw_eval']:.4f} → cal {m['ece_cal_eval']:.4f}   (target <0.05)")
    print(f"  ECE OA-only (held-out): raw {m['ece_raw_oa_eval']:.4f} → cal {m['ece_cal_oa_eval']:.4f}")
    print(f"  ECE corpus-only:        raw {m['ece_raw_corpus_eval']:.4f} → cal {m['ece_cal_corpus_eval']:.4f}")
    print(f"  MCE eval (bins n>=20): raw {m['mce_raw_eval']:.4f} → cal {m['mce_cal_eval']:.4f}")
    print(f"  Brier eval: raw {m['brier_raw_eval']:.4f} → cal {m['brier_cal_eval']:.4f}")

    rep_path = Path(args.report)
    rep_path.parent.mkdir(parents=True, exist_ok=True)
    rep_path.write_text(render_report(args, fit))
    print(f"wrote report → {rep_path}")


if __name__ == "__main__":
    main()
