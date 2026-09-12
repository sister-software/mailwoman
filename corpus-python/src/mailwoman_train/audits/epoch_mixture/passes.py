"""The two passes over one epoch: what the sampler drew, and what the trainer would read.

They open the SAME stream at the SAME seed, which is what makes their counts comparable — with
every augmentation probability at zero the two consume the rng identically and their counts are
byte-equal, which the test pins. The emitted pass still skips `iter_rows`' shuffle buffer, which
reorders rows and cannot change counts.
"""

from __future__ import annotations

import random
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ...data.emit import EmitPolicy, emit_row
from ...data.loader import _raw_row_stream, source_row_counts
from .receipts import CorpusReceiptError, matches_receipt

if TYPE_CHECKING:
    from ...config import CorpusReceiptConfig

AUGMENT_KEYS = ("directional", "region", "glue", "case", "punct_drop", "upper_case", "ordinal")


@dataclass
class DrawPass:
    """What the sampler itself produced, before any augmentation."""

    windows: list[Counter[str]]
    totals: Counter[str]
    countries: Counter[str]
    per_source: dict[str, dict[str, Any]]
    full_windows: int
    receipts: list[dict[str, Any]]


@dataclass
class EmittedPass:
    """What fills the trainer's row_limit budget, after the augmentation policy expands each row."""

    totals: Counter[str]
    countries: Counter[str]
    augmented_rows: int


def normalized_augment(augment: dict[str, float] | None) -> dict[str, float]:
    """Every augmentation key at its configured probability, defaulting to off.

    An unknown key RAISES rather than being ignored: a misspelled probability that silently reads
    as 0.0 reports the un-augmented mixture under the augmented run's name.
    """
    filled = dict.fromkeys(AUGMENT_KEYS, 0.0) | (augment or {})
    unknown = set(filled) - set(AUGMENT_KEYS)
    if unknown:
        raise ValueError(f"unknown augment keys {sorted(unknown)}; expected {AUGMENT_KEYS}")
    return filled


def requested_shares(source_weights: dict[str, float] | None) -> dict[str, float]:
    """The configured weights as the shares they ask for. A zero or negative weight asks for none."""
    if source_weights is None:
        return {}
    positive_total = sum(w for w in source_weights.values() if w > 0)
    return {src: w / positive_total for src, w in sorted(source_weights.items()) if w > 0}


def run_draw_pass(
    stream: Iterator[dict[str, Any]],
    *,
    corpus_dir: Path,
    draws: int,
    window: int,
    requested: dict[str, float],
    required_receipts: list[CorpusReceiptConfig],
) -> DrawPass:
    """Pass 1 — draw level, straight off the sampler.

    The per-window counts are the stationarity receipt: a source that exhausts mid-epoch keeps its
    share in the totals and loses it in the later windows, which a prefix audit cannot see.
    """
    n_windows = (draws + window - 1) // window
    window_counts: list[Counter[str]] = [Counter() for _ in range(n_windows)]
    draw_countries: Counter[str] = Counter()
    receipt_counts: Counter[str] = Counter()
    for i, row in enumerate(islice(stream, draws)):
        window_counts[i // window][row["source"]] += 1
        draw_countries[row["country"]] += 1
        for receipt in required_receipts:
            if matches_receipt(row, receipt):
                receipt_counts[receipt.name] += 1
    draw_totals = sum(window_counts, Counter())
    total_draws = sum(draw_totals.values())

    full_windows = [w for w in window_counts if sum(w.values()) == window]
    # DOSE, not just share (#1677). `reps_per_row` is the number every weight is implicitly choosing and
    # that nobody sees: a 0.60% share of 7.68M draws over 277 rows is 165 passes per row, while a 3.57%
    # share over 53,078 rows is 5. The v4.6.0 bare-country collapse was picked at weight 1.0 — the
    # smallest number in the config — by someone reading 1.0 as a small dose.
    rows_by_source = source_row_counts(corpus_dir, "train")

    per_source: dict[str, dict[str, Any]] = {}
    for src in sorted(set(draw_totals) | set(requested)):
        req = requested.get(src)
        share = draw_totals.get(src, 0) / total_draws if total_draws else 0.0
        deviations = [abs(w.get(src, 0) / window - req) / req for w in full_windows] if req else []
        rows = rows_by_source.get(src)
        draws_for_src = draw_totals.get(src, 0)
        per_source[src] = {
            "requested_share": req,
            "draws": draws_for_src,
            "draw_share": share,
            "max_window_relative_deviation": max(deviations) if deviations else 0.0,
            # `None` when the slice's row count could not be read — reported as unknown rather than as a
            # dose of zero, which would read as "this slice is safe".
            "rows": rows,
            "reps_per_row": (draws_for_src / rows) if rows else None,
        }

    return DrawPass(
        windows=window_counts,
        totals=draw_totals,
        countries=draw_countries,
        per_source=per_source,
        full_windows=len(full_windows),
        receipts=[
            {
                "name": receipt.name,
                "required_draws": receipt.min_draws,
                "observed_draws": receipt_counts[receipt.name],
                "source": receipt.source,
                "country": receipt.country,
                "component_sequence": receipt.component_sequence,
            }
            for receipt in required_receipts
        ],
    )


def run_emitted_pass(
    stream: Iterator[dict[str, Any]],
    rng: random.Random,
    *,
    draws: int,
    augment: dict[str, float],
    augment_exclude_sources: Sequence[str],
) -> EmittedPass:
    """Pass 2 — emitted level: the same stream expanded through the augmentation policy.

    The SAME emit step the trainer runs, exclusion included (#2243) — the audit reimplemented it
    once without the per-source exclusion and reported an excluded source with the count it would
    have had if augmented. The relabel lexicon stays absent: this pass counts rows per source and
    per country, and relabel rewrites labels within a row without adding or removing one.
    """
    policy = EmitPolicy(
        directional_prob=augment["directional"],
        region_prob=augment["region"],
        glue_prob=augment["glue"],
        case_prob=augment["case"],
        punct_drop_prob=augment["punct_drop"],
        upper_case_prob=augment["upper_case"],
        ordinal_prob=augment["ordinal"],
        excluded_sources=frozenset(augment_exclude_sources),
    )
    totals: Counter[str] = Counter()
    countries: Counter[str] = Counter()
    augmented_rows = 0
    emitted = 0
    for row in stream:
        if emitted >= draws:
            break
        outs = list(emit_row(row, rng, policy))
        for j, out in enumerate(outs):
            if emitted >= draws:
                break
            totals[out["source"]] += 1
            countries[out["country"]] += 1
            if j > 0:
                augmented_rows += 1
            emitted += 1
    return EmittedPass(totals=totals, countries=countries, augmented_rows=augmented_rows)


def emitted_per_source(
    emitted: EmittedPass, draw_per_source: dict[str, dict[str, Any]], requested: dict[str, float]
) -> dict[str, dict[str, Any]]:
    """Each source's emitted share, against the share the sampler drew it at.

    `distortion_vs_draw_share` above 1 is a source claiming more of the row budget than it was
    sampled at, which is what an augmentable source does to every source beside it.
    """
    total_emitted = sum(emitted.totals.values())
    out: dict[str, dict[str, Any]] = {}
    for src in sorted(set(emitted.totals) | set(requested)):
        e_share = emitted.totals.get(src, 0) / total_emitted if total_emitted else 0.0
        d_share = draw_per_source.get(src, {}).get("draw_share", 0.0)
        out[src] = {
            "emitted": emitted.totals.get(src, 0),
            "emitted_share": e_share,
            "distortion_vs_draw_share": (e_share / d_share) if d_share else None,
        }
    return out


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
    augment_exclude_sources: Sequence[str] = (),
    required_receipts: list[CorpusReceiptConfig] | None = None,
) -> dict[str, Any]:
    """Run both passes over one epoch of ``draws`` rows and return the report dict.

    ``augment_exclude_sources`` reaches the emitted pass because the TRAINER applies it. Both
    passes open the stream at the SAME seed, so the emitted counts are byte-equal to the draw
    counts when every augmentation is off.
    """
    filled_augment = normalized_augment(augment)
    if draws <= 0 or window <= 0:
        raise ValueError(f"draws ({draws}) and window ({window}) must be positive")
    requested = requested_shares(source_weights)

    def _stream(rng: random.Random) -> Iterator[dict[str, Any]]:
        return _raw_row_stream(
            Path(corpus_dir),
            "train",
            rng=rng,
            country_weights=country_weights,
            source_weights=source_weights,
            coarse_filter=coarse_filter,
        )

    drawn = run_draw_pass(
        _stream(random.Random(seed)),
        corpus_dir=Path(corpus_dir),
        draws=draws,
        window=window,
        requested=requested,
        required_receipts=required_receipts or [],
    )
    rng2 = random.Random(seed)
    emitted = run_emitted_pass(
        _stream(rng2),
        rng2,
        draws=draws,
        augment=filled_augment,
        augment_exclude_sources=augment_exclude_sources,
    )
    total_emitted = sum(emitted.totals.values())

    report: dict[str, Any] = {
        "requested": requested,
        "draw_level": {
            "totals": dict(drawn.totals),
            "windows": [dict(w) for w in drawn.windows],
            "per_source": drawn.per_source,
            "by_country": dict(drawn.countries.most_common()),
        },
        "emitted_level": {
            "totals": dict(emitted.totals),
            "per_source": emitted_per_source(emitted, drawn.per_source, requested),
            "by_country": dict(emitted.countries.most_common()),
            "augmented_share": emitted.augmented_rows / total_emitted if total_emitted else 0.0,
        },
        "meta": {
            "seed": seed,
            "draws_requested": draws,
            "draws_realized": sum(drawn.totals.values()),
            "window": window,
            "full_windows": drawn.full_windows,
            "corpus_dir": str(corpus_dir),
        },
        "required_corpus_receipts": drawn.receipts,
    }
    failures = [r for r in drawn.receipts if r["observed_draws"] < r["required_draws"]]
    report["meta"]["corpus_receipt_status"] = "fail" if failures else "pass"
    if failures:
        details = "; ".join(
            f"{r['name']}: observed {r['observed_draws']:,} of required {r['required_draws']:,} draws" for r in failures
        )
        raise CorpusReceiptError(f"required corpus receipts failed: {details}", report)
    return report
