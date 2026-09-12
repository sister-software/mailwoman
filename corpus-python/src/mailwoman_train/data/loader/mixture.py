"""Sampling across sources so the observed mix matches `source_weights`.

The mixture is STATIONARY for the whole epoch: an exhausted source restarts with a fresh shuffled
pass rather than leaving the multinomial, and the epoch ends once every source has completed at
least one full pass. Held-out splits take the other branch entirely — they have no mixture to
steer, and bucketing a mixed-source val slice by its first row would drop every later source.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from .corpus_files import _slice_first_source, _slice_paths
from .parquet import _slice_row_iter, _source_iter

logger = logging.getLogger(__name__)


def _stream_held_out(
    slice_paths: list[Path],
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict[str, Any]]:
    """Every filter-accepted row of every slice, slice order shuffled. No source bucketing.

    Non-train splits bypass source bucketing entirely (2026-08-09 P0). The bucketing identifies a
    slice's source from its FIRST row and filters every row to it — correct for the source-segregated
    train corpus, but a MIXED-source validation slice silently loses every later-source row (the
    inherited val slices are mixed, so "3 val slices" was never a coverage receipt). Held-out streams
    have no source mixture to steer.
    """
    order = [s for s in slice_paths if s.exists()]
    rng.shuffle(order)
    for s in order:
        # Keep the --golden misuse check the bucketing path used to provide: a label-less
        # golden slice (source=None) scoring as val would produce garbage metrics silently.
        if _slice_first_source(s) is None:
            raise ValueError(
                f"slice {s} has no `source` field — likely a --golden (label-less) slice used as a "
                f"{split!r} slice. Rebuild that slice WITHOUT --golden so rows carry source + labels."
            )
        yield from _slice_row_iter(
            s,
            expected_source=None,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )


def _index_by_source(slice_paths: list[Path]) -> dict[str, list[Path]]:
    """Bucket slices by their single `source` value, reading one row group per slice.

    Corpus v0.2.0 slices are 100% source-segregated, so the first row identifies the whole file. A
    slice that is missing or unreadable is skipped and named; one with a None source raises, because
    that is a --golden (label-less) slice used as a train slice and it used to fail later with a
    cryptic "'<' not supported between NoneType and str" from `sorted()`.
    """
    by_source: dict[str, list[Path]] = {}
    skipped: list[tuple[Path, str]] = []
    for s in slice_paths:
        if not s.exists():
            skipped.append((s, "file not found"))
            continue
        try:
            src = _slice_first_source(s)
        except Exception as exc:
            skipped.append((s, str(exc)))
            continue
        by_source.setdefault(src, []).append(s)

    if skipped:
        logger.warning(
            "Skipped %d slices (missing or unreadable):\n  %s",
            len(skipped),
            "\n  ".join(f"{p}: {reason}" for p, reason in skipped[:10]),
        )
    if any(src is None for src in by_source):
        n_none = sum(len(s) for src, s in by_source.items() if src is None)
        raise ValueError(
            f"{n_none} slice rows have no `source` field — likely a --golden (label-less) slice used as a "
            "train/val slice. Rebuild that slice WITHOUT --golden so rows carry source + labels."
        )
    logger.info(
        "Slice index: %s",
        ", ".join(f"{src}={len(slices)}" for src, slices in sorted(by_source.items())),
    )
    return by_source


def _apply_source_weights(
    by_source: dict[str, list[Path]], source_weights: dict[str, float], split: str
) -> dict[str, list[Path]]:
    """Drop the sources the weights decline, and refuse the ones they never mention.

    TWO different things get dropped here and only one of them is deliberate.

    A source NAMED at zero is the config declining it, and the config has no other way to say so —
    ``synth-no-street-led: 0.0`` is that sentence. A source the weights never MENTION is an
    oversight, and it is invisible from every direction: the caller's guard raises only for the
    mirror case (a positive weight with no slice), the sampler cannot miss what it never indexed,
    and the run log carries no trace. Because intent is expressible, the absence of intent is an
    error, so an unnamed source refuses on the split whose recipe claims coverage.

    The shape it hides: a regenerated slice takes a version suffix in its ``source`` column
    (``synth-fr-bare-street`` -> ``synth-fr-bare-street-v22``), the config keeps the old key, and
    training silently continues on the superseded vintage while the current generation sits out.
    The dose audit then reports the old vintage as a DOSE OUTLIER, because the whole weight lands on
    a fraction of the rows — which reads as an aggressive dose rather than a missing one.
    """
    unnamed = sorted(src for src in by_source if src not in source_weights)
    if unnamed and split == "train":
        detail = ", ".join(f"{src} ({len(by_source[src])} slices)" for src in unnamed)
        raise ValueError(
            f"{len(unnamed)} source(s) in the {split!r} split are absent from source_weights and would "
            f"be dropped without a trace: {detail}. Name each one — give it a weight to train on it, "
            "or 0.0 to decline it deliberately. Check for a superseded generation still holding the "
            "weight (a `-vNN` sibling of the same name)."
        )

    declined = {src for src in by_source if source_weights.get(src, 0) <= 0}
    kept = {src: slices for src, slices in by_source.items() if source_weights.get(src, 0) > 0}
    if declined:
        logger.info("Declined %d sources named at zero weight: %s", len(declined), sorted(declined))
    if not kept:
        raise ValueError(
            "no slices remain after applying source_weights — every slice's source "
            f"is missing from or zero-weighted in source_weights={source_weights!r}"
        )
    return kept


def _stationary_mixture(
    weights: dict[str, float],
    fresh_iter: Callable[[str], Iterator[dict[str, Any]]],
    rng: random.Random,
) -> Iterator[dict[str, Any]]:
    """Draw a source per row from a multinomial FIXED for the whole epoch.

    STATIONARY mixture (2026-08-09 P0). The previous loop deleted an exhausted source and
    renormalized the remaining weights, so ``source_weights`` was only the OPENING distribution: a
    small oversampled source (the #1569 30k-row suffix slice at weight 12.0) was live for ~3,330 of
    each ~7,812-step epoch and silent afterwards — the v4.3.3 B1 board oscillated in lockstep with
    those exposure windows. The multinomial is fixed now: an exhausted source restarts with a fresh
    shuffled pass (weighted sampling with replacement at the pass level), and the epoch ends once
    EVERY source has completed >= 1 full pass — the largest source is seen exactly once, and no
    source ever silently leaves the mixture.
    """
    iters = {src: fresh_iter(src) for src in weights}
    sources = list(iters.keys())
    cum: list[float] = []
    total = 0.0
    for src in sources:
        total += weights[src]
        cum.append(total)
    passes: dict[str, int] = dict.fromkeys(sources, 0)
    pass_rows: dict[str, int] = dict.fromkeys(sources, 0)
    realized: dict[str, int] = dict.fromkeys(sources, 0)

    while True:
        r = rng.random() * total
        chosen = sources[-1]
        for src, c in zip(sources, cum, strict=True):
            if r < c:
                chosen = src
                break
        try:
            row = next(iters[chosen])
        except StopIteration:
            # A pass that yielded nothing can never yield on a rerun (same rows, same
            # filters) — a positive-weight source with zero selectable rows is a recipe/
            # corpus contract violation, the runtime sibling of the unreachable-positive-
            # weight guard in `_raw_row_stream`. Loud, never a silent drop.
            if pass_rows[chosen] == 0:
                raise ValueError(
                    f"source {chosen!r} has a positive weight but yielded zero selectable rows in a "
                    "full pass (country_weights / coarse_filter admit nothing) — fix the recipe or "
                    "the corpus; a silent drop would change the training mixture"
                ) from None
            passes[chosen] += 1
            if all(n >= 1 for n in passes.values()):
                logger.info(
                    "Epoch complete (every source >= 1 full pass). Realized draws per source: %s",
                    ", ".join(f"{src}={realized[src]}" for src in sorted(realized)),
                )
                return
            pass_rows[chosen] = 0
            iters[chosen] = fresh_iter(chosen)
            row = next(iters[chosen])
        pass_rows[chosen] += 1
        realized[chosen] += 1
        yield row


def _raw_row_stream(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
) -> Iterator[dict[str, Any]]:
    """Internal stream: yields filter-accepted rows, sampled by weighted source multinomial.

    Wrapped by ``iter_rows`` with a reservoir-style shuffle buffer.

    Architecture:

    1. Bucket slices by their (single) ``source`` value. Corpus v0.2.0 slices are 100%
       source-segregated, so this is a one-time scan of one row-group header per slice.
    2. For each source, build a per-source row iterator that visits its slices in shuffled
       order. Each iterator yields rows after country + coarse filtering.
    3. On each pull, sample a source via the ``source_weights`` multinomial (or uniform
       when ``source_weights`` is None) and yield the next row from that source's iterator.
       The multinomial is FIXED for the whole epoch: an exhausted source restarts with a
       fresh shuffled pass, and the epoch ends once every source has completed at least one
       full pass (stationary mixture — see the 2026-08-09 P0 note at the sampling loop).
       Non-train splits skip all of this and stream every slice's rows directly.

    Why this and not per-row source acceptance:

    The naive approach of accepting each row with probability ``source_weights[source] /
    max(source_weights)`` was the original v0.2.0 implementation (PR #44). It is correct
    on average — the observed mix converges to ``raw_share × accept_share / norm`` — but
    under v0.2.0's slice layout it fails empirically: slices are 1M-row single-source
    blocks, so the downstream shuffle buffer fills entirely from the current slice's
    source before any cross-source mixing happens. Long runs of one source within a batch
    reproduce the positional-heuristic overfit that motivated this issue (#43).

    Source-level multinomial sampling makes the observed mix match ``source_weights``
    *exactly* per-pull, regardless of raw share or slice layout. Memory: one active
    row-group per source ≈ ``|sources| × 50 MB`` peak — ~300 MB for v0.2.0's 6 train-split
    sources, well within budget.
    """
    slice_paths = _slice_paths(corpus_dir, split)
    max_weight = max(country_weights.values())

    # Non-train splits bypass source bucketing entirely (2026-08-09 P0). The bucketing below
    # identifies a slice's source from its FIRST row and filters every row to it — correct for
    # the source-segregated train corpus, but a MIXED-source validation slice silently loses
    # every later-source row (the inherited val slices are mixed, so "3 val slices" was never a
    # coverage receipt). Held-out streams have no source mixture to steer; yield every
    # filter-accepted row of every slice, slice order shuffled.
    if split != "train":
        yield from _stream_held_out(
            slice_paths,
            split,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )
        return

    logger.info("Indexing %d slices by source...", len(slice_paths))
    by_source = _index_by_source(slice_paths)
    # ``source_weights`` describes the desired TRAIN mixture. Validation corpora intentionally
    # contain only a small fixed source subset, so requiring every positive training source there
    # would make the first scheduled validation fail even though its own slices are healthy. Keep
    # the stale-config guard on the split where the recipe makes its coverage claim.
    if source_weights is not None and split == "train":
        missing_positive = sorted(src for src, weight in source_weights.items() if weight > 0 and src not in by_source)
        if missing_positive:
            raise ValueError(
                f"positive source_weights entries have no slices in the {split!r} split: "
                f"{missing_positive}. Remove the stale weights or rebuild the corpus with those sources."
            )

    if source_weights is not None:
        by_source = _apply_source_weights(by_source, source_weights, split)

    def _fresh_iter(src: str) -> Iterator[dict[str, Any]]:
        return _source_iter(
            by_source[src],
            expected_source=src,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )

    weights = {src: float(source_weights[src]) if source_weights is not None else 1.0 for src in by_source}
    yield from _stationary_mixture(weights, _fresh_iter, rng)
