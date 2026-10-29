"""Choose the reps per row and derive the weight, through `mtf-sampler`'s `source_reps`.

The sampler allocates draw share by weight normalized across sources. Row count never enters, so a source's per-row
exposure is ``reps_per_row = (weight / total_weight) * total_samples / rows``, a unit configs do not express directly.
``source_reps`` lets a config set the exposure and derive the weight once the corpus is known. The derivation and the
row counts it reads run in Rust (`packages/mtf/crates/mtf-sampler/src/source_reps.rs`), so the weights the launch log
reports are the weights the Rust sampler reads.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mailwoman_mtf


@dataclass(frozen=True)
class DerivedReps:
    source: str
    target_reps_per_row: float
    rows: int
    weight: float


def total_samples(max_steps: int, batch_size: int, grad_accum_steps: int = 1) -> int:
    """Rows the trainer consumes over the run: every optimizer step reads ``batch_size * grad_accum_steps``."""
    return int(max_steps) * int(batch_size) * int(grad_accum_steps)


def derive_source_weights(
    fixed_weights: dict[str, float] | None,
    source_reps: dict[str, float] | None,
    rows_by_source: dict[str, int],
    samples: int,
) -> tuple[dict[str, float] | None, list[DerivedReps]]:
    """Merge ``source_reps`` into ``fixed_weights`` as derived weights.

    Returns the merged weights (``None`` when neither is set, preserving "every source passes") and the
    derivation record for the launch log. Raises when a reps-targeted source is also weighted, has no
    readable row count, or the reps targets together would need more than the run's samples.
    """
    if not source_reps:
        return (fixed_weights, [])
    merged, derived = mailwoman_mtf.derive_source_weights(
        list((fixed_weights or {}).items()),
        list(source_reps.items()),
        list(rows_by_source.items()),
        samples,
    )
    return dict(merged), [DerivedReps(*entry) for entry in derived]


def resolve_config_reps(cfg: Any, corpus_dir: Path | None = None) -> list[DerivedReps]:
    """Fold ``cfg.data.source_reps`` into ``cfg.data.source_weights`` in place, from the corpus on disk.

    The one resolution point the trainer and the epoch audit share, so the weights the audit reports
    are the weights the run samples with. A config without ``source_reps`` is left untouched.
    """
    reps = getattr(cfg.data, "source_reps", None)
    if not reps:
        return []
    from dataclasses import replace

    from .loader.encode import sampler_config

    data = replace(cfg.data, corpus_dir=str(corpus_dir)) if corpus_dir is not None else cfg.data
    rows_by_source = dict(mailwoman_mtf.source_row_counts(sampler_config(data), "train"))
    samples = total_samples(cfg.train.max_steps, cfg.train.batch_size, getattr(cfg.train, "grad_accum_steps", 1))
    merged, derived = derive_source_weights(cfg.data.source_weights, reps, rows_by_source, samples)
    cfg.data.source_weights = merged
    return derived


def format_derivation(derived: list[DerivedReps]) -> str:
    """The launch-log lines: one per reps-targeted source, weight beside the exposure it was chosen for."""
    if not derived:
        return ""
    lines = ["source_reps → source_weights (#1677):"]
    for d in derived:
        # Three decimals rather than one: a probe divides its reps targets by the step ratio, so exposures
        # are legitimately fractional and `%.1f` would print every one of them as `0.0`.
        lines.append(
            f"  {d.source:<32} {d.target_reps_per_row:>9.3f} reps/row × {d.rows:>9,} rows → weight {d.weight:.4f}"
        )
    return "\n".join(lines)
