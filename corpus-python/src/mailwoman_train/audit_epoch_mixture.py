"""Full-epoch requested-vs-realized source/country mixture audit.

2026-08-09 training-substrate audit (HANDOFF-CODEX-TO-CLAUDE §6, action 7): the 250k-row
prefix audits ended before any source exhausted, so the non-stationary sampler — a source
deleted and the mixture renormalized mid-epoch — was invisible to them. This audit consumes
ONE full row-limited epoch (the unit the trainer loops) and reports the mixture at two
levels:

- **draw level** — ``_raw_row_stream``'s own output (pre-augmentation), counted per fixed
  window of draws. This is the direct stationarity receipt for the cycling-sampler repair:
  every window of the epoch must hold every source at its requested share.
- **emitted level** — the same stream expanded through ``augment_row`` under the config's
  augmentation policy, counting what fills the trainer's ``row_limit`` budget. Augmented
  copies compete with originals for that budget, and augmentability is source-specific, so
  ``distortion_vs_draw_share`` quantifies the realized-weight distortion per source for
  quota design. The affix relabel pass mutates labels, never row counts, so it is
  deliberately absent here.

The emitted pass mirrors ``iter_rows``' emission policy (original always first, independent
per-augmentation fires, one shared rng) without its shuffle buffer — the buffer reorders
rows but cannot change counts, and skipping it keeps the pass cheap. With every probability
at zero the two passes consume the rng identically and their counts are byte-equal (pinned
by the test).

Typical volume-side run (see ``train_remote.py::audit_epoch_mixture``)::

    python -m mailwoman_train.audit_epoch_mixture \
      --config src/mailwoman_train/configs/v4.3.3-suffix-boundary-base-60k.yaml \
      --json epoch-mixture-audit.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter
from itertools import islice
from pathlib import Path
from typing import TYPE_CHECKING

from .augment import augment_row
from .data_loader import _raw_row_stream, source_row_counts

if TYPE_CHECKING:
    from .config import CorpusReceiptConfig

_AUGMENT_KEYS = ("directional", "region", "glue", "case", "punct_drop", "upper_case", "ordinal")


class CorpusReceiptError(ValueError):
    """A failed receipt audit with its complete report attached for persistence."""

    def __init__(self, message: str, report: dict):
        super().__init__(message)
        self.report = report


def corpus_receipt_binding(config_path: Path, corpus_dir: Path) -> str:
    """Bind a passing receipt audit to the exact config and corpus manifest bytes."""
    manifest_path = corpus_dir / "MANIFEST.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"required corpus receipt binding needs {manifest_path}")
    digest = hashlib.sha256()
    for path in (config_path, manifest_path):
        contents = path.read_bytes()
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return digest.hexdigest()


def verify_corpus_receipt_binding(
    config_path: Path,
    corpus_dir: Path,
    required_receipts: list[CorpusReceiptConfig],
    token: str,
) -> None:
    """Refuse a receipt-bearing GPU run unless the CPU audit bound these bytes."""
    if not required_receipts:
        return
    if token != corpus_receipt_binding(config_path, corpus_dir):
        raise RuntimeError(
            "required corpus receipts were not audited against these config and manifest bytes; "
            "run the CPU receipt preflight before allocating a GPU"
        )


def verify_corpus_receipt_report(
    config_path: Path,
    corpus_dir: Path,
    required_receipts: list[CorpusReceiptConfig],
    token: str,
    report_path: Path,
) -> None:
    """Verify that the bound CPU audit persisted a passing report."""
    if not required_receipts:
        return
    verify_corpus_receipt_binding(config_path, corpus_dir, required_receipts, token)
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"required passing corpus receipt report is unreadable: {report_path}") from exc
    meta = report.get("meta", {})
    if meta.get("corpus_receipt_status") != "pass" or meta.get("corpus_receipt_binding") != token:
        raise RuntimeError(f"required corpus receipt report is not a passing audit for these bytes: {report_path}")


def audit_mixture(
    corpus_dir: Path,
    *,
    seed: int,
    draws: int,
    window: int,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
    augment: dict[str, float] | None = None,
    required_receipts: list[CorpusReceiptConfig] | None = None,
) -> dict:
    """Run both passes over one epoch of ``draws`` rows and return the report dict."""
    augment = dict.fromkeys(_AUGMENT_KEYS, 0.0) | (augment or {})
    unknown = set(augment) - set(_AUGMENT_KEYS)
    if unknown:
        raise ValueError(f"unknown augment keys {sorted(unknown)}; expected {_AUGMENT_KEYS}")
    if draws <= 0 or window <= 0:
        raise ValueError(f"draws ({draws}) and window ({window}) must be positive")

    requested: dict[str, float] = {}
    if source_weights is not None:
        positive_total = sum(w for w in source_weights.values() if w > 0)
        requested = {src: w / positive_total for src, w in sorted(source_weights.items()) if w > 0}

    def _stream(rng: random.Random):
        return _raw_row_stream(
            Path(corpus_dir),
            "train",
            rng=rng,
            country_weights=country_weights,
            source_weights=source_weights,
            coarse_filter=coarse_filter,
        )

    # Pass 1 — draw level, straight off the sampler.
    n_windows = (draws + window - 1) // window
    window_counts: list[Counter] = [Counter() for _ in range(n_windows)]
    draw_countries: Counter = Counter()
    receipt_counts: Counter = Counter()
    for i, row in enumerate(islice(_stream(random.Random(seed)), draws)):
        window_counts[i // window][row["source"]] += 1
        draw_countries[row["country"]] += 1
        for receipt in required_receipts or []:
            if _matches_receipt(row, receipt):
                receipt_counts[receipt.name] += 1
    draw_totals = sum(window_counts, Counter())
    total_draws = sum(draw_totals.values())

    full_windows = [w for w in window_counts if sum(w.values()) == window]
    # DOSE, not just share (#1677). `reps_per_row` is the number every weight is implicitly choosing and
    # that nobody sees: a 0.60% share of 7.68M draws over 277 rows is 165 passes per row, while a 3.57%
    # share over 53,078 rows is 5. The v4.6.0 bare-country collapse was picked at weight 1.0 — the
    # smallest number in the config — by someone reading 1.0 as a small dose.
    rows_by_source = source_row_counts(Path(corpus_dir), "train")

    draw_per_source: dict[str, dict] = {}
    for src in sorted(set(draw_totals) | set(requested)):
        req = requested.get(src)
        share = draw_totals.get(src, 0) / total_draws if total_draws else 0.0
        deviations = [abs(w.get(src, 0) / window - req) / req for w in full_windows] if req else []
        rows = rows_by_source.get(src)
        draws_for_src = draw_totals.get(src, 0)
        draw_per_source[src] = {
            "requested_share": req,
            "draws": draws_for_src,
            "draw_share": share,
            "max_window_relative_deviation": max(deviations) if deviations else 0.0,
            # `None` when the shard's row count could not be read — reported as unknown rather than as a
            # dose of zero, which would read as "this shard is safe".
            "rows": rows,
            "reps_per_row": (draws_for_src / rows) if rows else None,
        }

    receipts = [
        {
            "name": receipt.name,
            "required_draws": receipt.min_draws,
            "observed_draws": receipt_counts[receipt.name],
            "source": receipt.source,
            "country": receipt.country,
            "component_sequence": receipt.component_sequence,
        }
        for receipt in required_receipts or []
    ]
    failures = [r for r in receipts if r["observed_draws"] < r["required_draws"]]

    # Pass 2 — emitted level: the same stream expanded through the augmentation policy,
    # counting what fills the trainer's row_limit budget.
    rng2 = random.Random(seed)
    do_augment = any(p > 0 for p in augment.values())
    emitted_totals: Counter = Counter()
    emitted_countries: Counter = Counter()
    augmented_rows = 0
    emitted = 0
    for row in _stream(rng2):
        if emitted >= draws:
            break
        outs = (
            list(
                augment_row(
                    row,
                    rng2,
                    directional_prob=augment["directional"],
                    region_prob=augment["region"],
                    glue_prob=augment["glue"],
                    case_prob=augment["case"],
                    punct_drop_prob=augment["punct_drop"],
                    upper_case_prob=augment["upper_case"],
                    ordinal_prob=augment["ordinal"],
                )
            )
            if do_augment
            else [row]
        )
        for j, out in enumerate(outs):
            if emitted >= draws:
                break
            emitted_totals[out["source"]] += 1
            emitted_countries[out["country"]] += 1
            if j > 0:
                augmented_rows += 1
            emitted += 1

    total_emitted = sum(emitted_totals.values())
    emitted_per_source: dict[str, dict] = {}
    for src in sorted(set(emitted_totals) | set(requested)):
        e_share = emitted_totals.get(src, 0) / total_emitted if total_emitted else 0.0
        d_share = draw_per_source.get(src, {}).get("draw_share", 0.0)
        emitted_per_source[src] = {
            "emitted": emitted_totals.get(src, 0),
            "emitted_share": e_share,
            "distortion_vs_draw_share": (e_share / d_share) if d_share else None,
        }

    report = {
        "requested": requested,
        "draw_level": {
            "totals": dict(draw_totals),
            "windows": [dict(w) for w in window_counts],
            "per_source": draw_per_source,
            "by_country": dict(draw_countries.most_common()),
        },
        "emitted_level": {
            "totals": dict(emitted_totals),
            "per_source": emitted_per_source,
            "by_country": dict(emitted_countries.most_common()),
            "augmented_share": augmented_rows / total_emitted if total_emitted else 0.0,
        },
        "meta": {
            "seed": seed,
            "draws_requested": draws,
            "draws_realized": total_draws,
            "window": window,
            "full_windows": len(full_windows),
            "corpus_dir": str(corpus_dir),
        },
        "required_corpus_receipts": receipts,
    }
    report["meta"]["corpus_receipt_status"] = "fail" if failures else "pass"
    if failures:
        details = "; ".join(
            f"{r['name']}: observed {r['observed_draws']:,} of required {r['required_draws']:,} draws" for r in failures
        )
        raise CorpusReceiptError(f"required corpus receipts failed: {details}", report)
    return report


def _component_sequence(labels: list[str]) -> list[str]:
    """Collapse BIO token labels to their ordered component-span sequence."""
    sequence: list[str] = []
    active: str | None = None
    for label in labels:
        if label == "O":
            active = None
            continue
        if "-" not in label:
            raise ValueError(f"malformed BIO label {label!r}: expected O, B-<component>, or I-<component>")
        prefix, component = label.split("-", 1)
        if prefix not in {"B", "I"} or not component:
            raise ValueError(f"malformed BIO label {label!r}: expected O, B-<component>, or I-<component>")
        if prefix == "I" and active != component:
            raise ValueError(f"orphan BIO label {label!r}: active component is {active!r}")
        if prefix == "B":
            sequence.append(component)
        active = component
    return sequence


def _contains_contiguous(sequence: list[str], expected: list[str]) -> bool:
    if not expected:
        return True
    width = len(expected)
    return any(sequence[start : start + width] == expected for start in range(len(sequence) - width + 1))


def _matches_receipt(row: dict, receipt: CorpusReceiptConfig) -> bool:
    if receipt.source is not None and row.get("source") != receipt.source:
        return False
    if receipt.country is not None and row.get("country") != receipt.country:
        return False
    return _contains_contiguous(_component_sequence(row.get("labels", [])), receipt.component_sequence)


def run(
    config_path: Path,
    *,
    corpus_dir: Path | None = None,
    json_path: Path | None = None,
    window: int = 100_000,
    epoch: int = 1,
    draws: int | None = None,
) -> dict:
    """Audit one epoch exactly as the trainer would sample it for ``epoch``.

    Seed follows the train loop's convention (``cfg.train.seed + epoch``); the epoch length
    is the config's ``train_rows_per_epoch`` unless ``draws`` overrides it.
    """
    from .config import load_config

    cfg = load_config(config_path)
    d = cfg.data
    resolved_corpus_dir = corpus_dir or Path(d.corpus_dir)
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
    _print_summary(report)
    if failure is not None:
        raise failure
    return report


#: A source whose per-row exposure exceeds this multiple of the median is almost certainly a mistake.
#: 8x is deliberately loose — the #1677 case was 33x the shards weighted six times higher, so a guard
#: that only catches THAT is a guard for one incident rather than for the foot-gun.
_DOSE_OUTLIER_MULTIPLE = 8.0


def _print_summary(report: dict) -> None:
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

    receipts = report.get("required_corpus_receipts", [])
    if receipts:
        print(f"\nrequired corpus receipts ({report['meta']['draws_realized']:,} sampled rows):")
        for receipt in receipts:
            print(f"  {receipt['name']}: {receipt['observed_draws']:,} observed; minimum {receipt['required_draws']:,}")

    # The guard #1677 asks for. Loud, at the point a human is looking at the mixture, because the whole
    # failure was that the number nobody printed was the number that mattered.
    doses = sorted(s["reps_per_row"] for s in per_source.values() if s.get("reps_per_row"))
    if doses:
        median = doses[len(doses) // 2]
        hot = {
            src: s["reps_per_row"]
            for src, s in per_source.items()
            if s.get("reps_per_row") and s["reps_per_row"] > median * _DOSE_OUTLIER_MULTIPLE
        }
        if hot:
            print(
                f"\n⚠ DOSE OUTLIER — median exposure is {median:.1f} reps/row; these exceed "
                f"{_DOSE_OUTLIER_MULTIPLE:g}x that:"
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
        # Absence reported as absence: a shard whose rows could not be read has an UNKNOWN dose, which is
        # different from a safe one, and the outlier guard above could not have considered it.
        print(f"\n  row count unavailable, dose UNKNOWN (not safe): {', '.join(sorted(unknown))}")


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


if __name__ == "__main__":
    main()
