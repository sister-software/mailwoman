"""Choose the reps per row, derive the weight (#1677).

The sampler allocates draw share by weight normalised across sources. row count never enters. So the
per-row exposure of a source is

    reps_per_row = (weight / total_weight) * total_samples / rows

and a 277-row source at weight 1.0 — the smallest number in a config whose weights summed to 168 — was
shown 165 times per row while the 53,078-row source at weight 6.0 was shown 5. Nobody picks 165. weight
does not carry the unit anyone reasons in. ``source_reps`` lets a config name the exposure directly and
have the weight derived at the point the corpus is known.

The derivation inverts the formula, holding the fixed weights fixed. With ``W`` the sum of the fixed
weights, ``S`` the run's total samples, and ``D = sum(reps_i * rows_i)`` over the reps-targeted sources,
those sources take ``D / S`` of the draws, so ``total_weight = W / (1 - D / S)`` and

    weight_i = reps_i * rows_i * total_weight / S

The reps-targeted sources' draws come out of the fixed sources' share, exactly as adding any weight does.
``D`` must stay below ``S``, and at least one source must carry a fixed weight, or there is nothing to
derive the scale against.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


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
    fixed = dict(fixed_weights or {})
    if not source_reps:
        return (fixed_weights, [])
    if samples <= 0:
        raise ValueError(f"total samples must be positive to derive a weight from reps per row, got {samples}")

    both = sorted(set(source_reps) & set(fixed))
    if both:
        raise ValueError(f"sources carry both a weight and a reps target: {both}; a source takes one or the other")

    positive_fixed = sum(w for w in fixed.values() if w > 0)
    if positive_fixed <= 0:
        raise ValueError("source_reps need at least one positively weighted source in source_weights to derive against")

    missing = sorted(src for src in source_reps if not rows_by_source.get(src))
    if missing:
        # An unreadable row count is an unknown exposure rather than zero reps per row. deriving a weight from it would
        # be the silent-mixture defect in a new costume.
        raise ValueError(f"reps-targeted sources have no readable train rows in the corpus: {missing}")

    demanded = sum(reps * rows_by_source[src] for src, reps in source_reps.items())
    if demanded >= samples:
        raise ValueError(
            f"source_reps demand {demanded:,.0f} draws, at or over the run's {samples:,} samples; lower a reps target or lengthen the run"
        )

    scale = positive_fixed / (1.0 - demanded / samples)
    derived: list[DerivedReps] = []
    merged = dict(fixed)
    for src, reps in sorted(source_reps.items()):
        if reps <= 0:
            raise ValueError(f"source_reps[{src!r}] must be positive, got {reps}")
        rows = rows_by_source[src]
        weight = reps * rows * scale / samples
        merged[src] = weight
        derived.append(DerivedReps(source=src, target_reps_per_row=reps, rows=rows, weight=weight))

    return (merged, derived)


def resolve_config_reps(cfg: Any, corpus_dir: Path | None = None) -> list[DerivedReps]:
    """Fold ``cfg.data.source_reps`` into ``cfg.data.source_weights`` in place, from the corpus on disk.

    The one resolution point the trainer and the epoch audit share, so the weights the audit reports are
    the weights the run samples with. A config without ``source_reps`` is left untouched.
    """
    reps = getattr(cfg.data, "source_reps", None)
    if not reps:
        return []
    from .loader import source_row_counts

    rows_by_source = source_row_counts(Path(corpus_dir or cfg.data.corpus_dir), "train")
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
        # Three decimals rather than one: a probe holds the full run's mixture share by dividing its reps targets by
        # the step ratio, so its exposures are legitimately fractional and `%.1f` printed every one of them as
        # `0.0` — the launch log hiding the exact number this whole mechanism exists to put in front of someone.
        lines.append(
            f"  {d.source:<32} {d.target_reps_per_row:>9.3f} reps/row × {d.rows:>9,} rows → weight {d.weight:.4f}"
        )
    return "\n".join(lines)
