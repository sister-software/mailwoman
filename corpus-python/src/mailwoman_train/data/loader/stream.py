"""The shuffle buffer, the train-only policy, and the augmentation step.

The single choke point every caller flows through — the train loop, the eval scripts and the
audits — which is why the held-out neutralization lives here rather than at each caller.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

from ..emit import EmitPolicy, emit_row
from ..relabel import AffixRelabelLexicon
from .mixture import _raw_row_stream

logger = logging.getLogger(__name__)


def iter_rows(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None = None,
    coarse_filter: bool,
    row_limit: int | None = None,
    augment_directional_prob: float = 0.0,
    augment_region_prob: float = 0.0,
    augment_glue_prob: float = 0.0,
    augment_case_prob: float = 0.0,
    augment_punct_drop_prob: float = 0.0,
    augment_upper_case_prob: float = 0.0,
    augment_ordinal_prob: float = 0.0,
    augment_exclude_sources: Sequence[str] = (),
    affix_relabel_lexicon: AffixRelabelLexicon | None = None,
    shuffle_buffer: int = 131072,
) -> Iterator[dict[str, Any]]:
    """Yield rows from parquet slices, filtered + shuffled.

    Shuffling is done at three levels:

    1. Slice order (per-epoch): slices visited in random order.
    2. Row-group order within slice: row-groups visited in random order.
    3. Within row-group: row indices permuted before scan.

    Then a reservoir-style ``shuffle_buffer`` of size ``shuffle_buffer`` rows mixes
    yields across row-group boundaries. This is the standard HuggingFace ``streaming``
    shuffle pattern: hold ``N`` rows, pop a random one, replace from the upstream stream
    (when exhausted, drain the buffer in random order).

    Skipping shuffle (``shuffle_buffer<=0``) is intentionally not supported — the previous
    sequential layout caused val_loss to diverge at step ~1500. Always shuffle.

    Per Phase 2 §2 (stratified sampling): ``country_weights`` is applied during the raw
    scan, *before* the buffer, so sampled fractions land in the buffer with the configured
    weights. ``source_weights`` multiplies with ``country_weights`` — a row must pass
    both to survive. When ``source_weights`` is ``None`` (default), all sources pass.

    Memory: each buffered row is a dict of {raw: str, tokens: list[str], labels: list[str],
    country: str, source: str}. For Stage 1 coarse rows, that's ~1 KB per row; default
    131072 buffer is ~128 MB resident, well within budget. The v0.1.1 default of 16384
    was sized for a 22M-row corpus; v0.2.0 ships 263M rows so the same 16k buffer would
    sample only 0.006% per shuffle — within-slice order would dominate. 128k buffer
    samples 0.05% which restores effective randomness without meaningful RAM impact.
    """
    if not country_weights:
        raise ValueError("country_weights must be non-empty")
    # TRAIN-ONLY policy stays out of held-out streams (2026-08-09 P0): source weighting,
    # random augmentation, and the online affix relabel are training-mixture decisions.
    # Applied to val they made the headline metric score an augmented, training-filtered
    # slice — deterministic under the fixed seed, but not clean held-out performance. A
    # deliberately-augmented robustness suite must be an explicitly named second eval, not
    # the default val stream. Neutralize here, at the single choke point every caller
    # (train loop, eval scripts) flows through.
    if split != "train":
        neutralized = [
            name
            for name, active in (
                ("source_weights", source_weights is not None),
                (
                    "augmentation",
                    any(
                        p > 0
                        for p in (
                            augment_directional_prob,
                            augment_region_prob,
                            augment_glue_prob,
                            augment_case_prob,
                            augment_punct_drop_prob,
                            augment_upper_case_prob,
                            augment_ordinal_prob,
                        )
                    ),
                ),
                ("affix_relabel", affix_relabel_lexicon is not None),
            )
            if active
        ]
        if neutralized:
            logger.info("split=%r: train-only policy disabled for held-out stream: %s", split, neutralized)
        source_weights = None
        augment_directional_prob = augment_region_prob = augment_glue_prob = 0.0
        augment_case_prob = augment_punct_drop_prob = augment_upper_case_prob = 0.0
        augment_ordinal_prob = 0.0
        affix_relabel_lexicon = None
    upstream = _raw_row_stream(
        corpus_dir,
        split,
        rng=rng,
        country_weights=country_weights,
        source_weights=source_weights,
        coarse_filter=coarse_filter,
    )
    buf: list[dict[str, Any]] = []
    yielded = 0
    # Fill the buffer first.
    try:
        for _ in range(shuffle_buffer):
            buf.append(next(upstream))
    except StopIteration:
        pass
    # The augmentation and relabel policies live in `emit.py` so this loader and every audit apply the
    # identical step. They did not once: the epoch audit reimplemented it without the per-source
    # exclusion and reported an excluded source with the count it would have had if augmented (#2243).
    policy = EmitPolicy(
        directional_prob=augment_directional_prob,
        region_prob=augment_region_prob,
        glue_prob=augment_glue_prob,
        case_prob=augment_case_prob,
        punct_drop_prob=augment_punct_drop_prob,
        upper_case_prob=augment_upper_case_prob,
        ordinal_prob=augment_ordinal_prob,
        excluded_sources=frozenset(augment_exclude_sources),
        relabel_lexicon=affix_relabel_lexicon,
    )

    def _emit(row: dict[str, Any]) -> Iterator[dict[str, Any]]:
        return emit_row(row, rng, policy)

    # Stream out: every time we yield, pull the next from upstream into the freed slot.
    for row in upstream:
        j = rng.randrange(len(buf))
        out = buf[j]
        buf[j] = row
        for emitted in _emit(out):
            yield emitted
            yielded += 1
            if row_limit is not None and yielded >= row_limit:
                return
    # Drain whatever remains in the buffer.
    rng.shuffle(buf)
    for out in buf:
        for emitted in _emit(out):
            yield emitted
            yielded += 1
            if row_limit is not None and yielded >= row_limit:
                return
