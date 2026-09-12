"""Running the audit from a recipe, and printing the mixture where a human will read it.

The printed summary is not decoration. #1677 was a weight chosen as a number rather than as a dose:
the exposure every weight implicitly picks — passes per row — was in nobody's output, so the one
figure that mattered was the one nobody saw. The dose column and the outlier warning below exist to
put it in front of whoever is looking at the mixture.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from ...data.dose import format_derivation, resolve_config_doses
from .passes import audit_mixture
from .receipts import CorpusReceiptError, corpus_receipt_binding

#: A source whose per-row exposure exceeds this multiple of the median is almost certainly a mistake.
#: 8x is deliberately loose — the #1677 case was 33x the slices weighted six times higher, so a guard
#: that only catches THAT is a guard for one incident rather than for the foot-gun.
DOSE_OUTLIER_MULTIPLE = 8.0


def run(
    config_path: Path,
    *,
    corpus_dir: Path | None = None,
    json_path: Path | None = None,
    window: int = 100_000,
    epoch: int = 1,
    draws: int | None = None,
) -> dict[str, Any]:
    """Audit one epoch exactly as the trainer would sample it for ``epoch``.

    Seed follows the train loop's convention (``cfg.train.seed + epoch``); the epoch length
    is the config's ``train_rows_per_epoch`` unless ``draws`` overrides it.
    """
    from ...config import load_config

    cfg = load_config(config_path)
    d = cfg.data
    resolved_corpus_dir = corpus_dir or Path(d.corpus_dir)
    # The same resolution the trainer runs (#1677), so the audit reports the weights the run will sample with.
    derived_doses = resolve_config_doses(cfg, resolved_corpus_dir)
    if derived_doses:
        print(format_derivation(derived_doses))
    epoch_rows = draws or getattr(d, "train_rows_per_epoch", None)
    if not epoch_rows:
        raise ValueError("config has no train_rows_per_epoch — pass --draws for the epoch length")
    failure: CorpusReceiptError | None = None
    try:
        report = audit_mixture(
            resolved_corpus_dir,
            seed=cfg.train.seed + epoch,
            draws=int(epoch_rows),
            window=window,
            country_weights=d.country_weights,
            source_weights=d.source_weights,
            coarse_filter=d.coarse_filter,
            augment={
                "directional": d.augment_directional_prob,
                "region": d.augment_region_prob,
                "glue": getattr(d, "augment_glue_prob", 0.0),
                "case": getattr(d, "augment_case_prob", 0.0),
                "punct_drop": getattr(d, "augment_punct_drop_prob", 0.0),
                "upper_case": getattr(d, "augment_upper_case_prob", 0.0),
                "ordinal": getattr(d, "augment_ordinal_prob", 0.0),
            },
            augment_exclude_sources=getattr(d, "augment_exclude_sources", ()) or (),
            required_receipts=d.required_corpus_receipts,
        )
    except CorpusReceiptError as exc:
        report = exc.report
        failure = exc
    report["meta"]["config"] = str(config_path)
    report["meta"]["epoch"] = epoch
    if d.required_corpus_receipts:
        report["meta"]["corpus_receipt_binding"] = corpus_receipt_binding(config_path, resolved_corpus_dir)
    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {json_path}")
    print_summary(report)
    if failure is not None:
        raise failure
    return report


def _print_source_table(report: dict[str, Any]) -> None:
    per_source = report["draw_level"]["per_source"]
    print(f"\n=== epoch mixture audit ({report['meta']['draws_realized']:,} draws) ===")
    print(
        f"{'source':<28} {'requested':>9} {'draws':>9} {'realized':>9} "
        f"{'rows':>9} {'reps/row':>9} {'max win dev':>11} {'emit dist':>9}"
    )
    for src, stats in per_source.items():
        emit = report["emitted_level"]["per_source"].get(src, {})
        req = stats["requested_share"]
        dist = emit.get("distortion_vs_draw_share")
        rows = stats.get("rows")
        reps = stats.get("reps_per_row")
        print(
            f"{src:<28} {req if req is not None else float('nan'):>9.4f} {stats['draws']:>9,} "
            f"{stats['draw_share']:>9.4f} {rows if rows is not None else 0:>9,} "
            f"{reps if reps is not None else float('nan'):>9.1f} "
            f"{stats['max_window_relative_deviation']:>11.3f} "
            f"{dist if dist is not None else float('nan'):>9.3f}"
        )
    print(f"augmented share of emitted rows: {report['emitted_level']['augmented_share']:.3f}")


def _print_receipts(report: dict[str, Any]) -> None:
    receipts = report.get("required_corpus_receipts", [])
    if not receipts:
        return
    print(f"\nrequired corpus receipts ({report['meta']['draws_realized']:,} sampled rows):")
    for receipt in receipts:
        print(f"  {receipt['name']}: {receipt['observed_draws']:,} observed; minimum {receipt['required_draws']:,}")


def _print_dose_guard(per_source: dict[str, dict[str, Any]]) -> None:
    """Warn where one source's per-row exposure dwarfs the rest, and say how to pick a dose instead.

    A source whose row count could not be read is named separately: an unknown dose is not a safe
    one, and the outlier comparison could not have considered it.
    """
    doses = sorted(s["reps_per_row"] for s in per_source.values() if s.get("reps_per_row"))
    if doses:
        median = doses[len(doses) // 2]
        hot = {
            src: s["reps_per_row"]
            for src, s in per_source.items()
            if s.get("reps_per_row") and s["reps_per_row"] > median * DOSE_OUTLIER_MULTIPLE
        }
        if hot:
            print(
                f"\n⚠ DOSE OUTLIER — median exposure is {median:.1f} reps/row; these exceed "
                f"{DOSE_OUTLIER_MULTIPLE:g}x that:"
            )
            for src, reps in sorted(hot.items(), key=lambda kv: -kv[1]):
                rows = per_source[src].get("rows") or 0
                print(f"    {src:<28} {reps:>9.1f} reps/row over {rows:,} rows")
            print(
                "  Weight is not dose. To choose an exposure directly, invert it: "
                "weight = target_reps x rows x total_weight / total_samples (#1677)."
            )

    unknown = [src for src, s in per_source.items() if s.get("rows") is None]
    if unknown:
        print(f"\n  row count unavailable, dose UNKNOWN (not safe): {', '.join(sorted(unknown))}")


def print_summary(report: dict[str, Any]) -> None:
    _print_source_table(report)
    _print_receipts(report)
    _print_dose_guard(report["draw_level"]["per_source"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--corpus-dir", type=Path, help="Override data.corpus_dir from the config")
    parser.add_argument("--json", type=Path)
    parser.add_argument("--window", type=int, default=100_000)
    parser.add_argument("--epoch", type=int, default=1, help="Epoch number (seed = train.seed + epoch)")
    parser.add_argument("--draws", type=int, help="Override the epoch length (default train_rows_per_epoch)")
    args = parser.parse_args()
    run(
        args.config,
        corpus_dir=args.corpus_dir,
        json_path=args.json,
        window=args.window,
        epoch=args.epoch,
        draws=args.draws,
    )
