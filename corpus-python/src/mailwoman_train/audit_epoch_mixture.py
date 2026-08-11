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
import json
import random
from collections import Counter
from itertools import islice
from pathlib import Path

from .augment import augment_row
from .data_loader import _raw_row_stream

_AUGMENT_KEYS = ("directional", "region", "glue", "case", "punct_drop", "upper_case", "ordinal")


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
    for i, row in enumerate(islice(_stream(random.Random(seed)), draws)):
        window_counts[i // window][row["source"]] += 1
        draw_countries[row["country"]] += 1
    draw_totals = sum(window_counts, Counter())
    total_draws = sum(draw_totals.values())

    full_windows = [w for w in window_counts if sum(w.values()) == window]
    draw_per_source: dict[str, dict] = {}
    for src in sorted(set(draw_totals) | set(requested)):
        req = requested.get(src)
        share = draw_totals.get(src, 0) / total_draws if total_draws else 0.0
        deviations = [abs(w.get(src, 0) / window - req) / req for w in full_windows] if req else []
        draw_per_source[src] = {
            "requested_share": req,
            "draws": draw_totals.get(src, 0),
            "draw_share": share,
            "max_window_relative_deviation": max(deviations) if deviations else 0.0,
        }

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

    return {
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
    }


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
    epoch_rows = draws or getattr(d, "train_rows_per_epoch", None)
    if not epoch_rows:
        raise ValueError("config has no train_rows_per_epoch — pass --draws for the epoch length")
    report = audit_mixture(
        corpus_dir or Path(d.corpus_dir),
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
    )
    report["meta"]["config"] = str(config_path)
    report["meta"]["epoch"] = epoch
    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {json_path}")
    _print_summary(report)
    return report


def _print_summary(report: dict) -> None:
    print(f"\n=== epoch mixture audit ({report['meta']['draws_realized']:,} draws) ===")
    print(f"{'source':<28} {'requested':>9} {'draws':>9} {'realized':>9} {'max win dev':>11} {'emit dist':>9}")
    for src, stats in report["draw_level"]["per_source"].items():
        emit = report["emitted_level"]["per_source"].get(src, {})
        req = stats["requested_share"]
        dist = emit.get("distortion_vs_draw_share")
        print(
            f"{src:<28} {req if req is not None else float('nan'):>9.4f} {stats['draws']:>9,} "
            f"{stats['draw_share']:>9.4f} {stats['max_window_relative_deviation']:>11.3f} "
            f"{dist if dist is not None else float('nan'):>9.3f}"
        )
    print(f"augmented share of emitted rows: {report['emitted_level']['augmented_share']:.3f}")


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
