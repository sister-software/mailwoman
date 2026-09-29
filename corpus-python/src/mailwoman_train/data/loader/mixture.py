"""Sample across sources so the observed mix matches `source_weights`.

The mixture is STATIONARY for the whole epoch. An exhausted source restarts with a fresh shuffled
pass rather than leaving the multinomial. The epoch ends once every source has completed at least
    one full pass. Held-out splits use a separate branch with no mixture to steer. The sampler buckets a
mixed-source validation file by its first row would drop every later source.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from .corpus_files import _parquet_paths, file_source_counts
from .parquet import _file_row_iter, _source_iter

logger = logging.getLogger(__name__)


def _stream_held_out(
    paths: list[Path],
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict[str, Any]]:
    """Every filter-accepted row of every parquet file, file order shuffled, with no source bucketing.

    The sampler identifies a file's source from its first row and filters every row to it — correct for
    the source-segregated train corpus, but a mixed-source validation file silently loses its
    later-source rows. Held-out streams have no source mixture to steer.
    """
    order = [s for s in paths if s.exists()]
    rng.shuffle(order)
    for s in order:
        # Keep a --golden misuse check here. A label-less golden file used for val would produce
        # garbage metrics. `file_source_counts` raises on the non-string cell such a file contains.
        try:
            file_source_counts(s)
        except TypeError as exc:
            raise ValueError(
                f"parquet file {s} has no `source` field — likely a --golden (label-less) file used as a "
                f"{split!r} file. Rebuild it WITHOUT --golden so rows carry source + labels."
            ) from exc
        yield from _file_row_iter(
            s,
            expected_source=None,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )


def _index_by_source(paths: list[Path]) -> dict[str, list[Path]]:
    """Bucket parquet files by every `source` they list.

    Index a file under each source it lists. `_file_row_iter` filters for the requested source.
    A file listing two sources is read twice. Each pass yields only that source's rows.
    `packages/corpus/lib/parquet/writers.ts` closes a part at `rowsPerFile` rows, including between
    sources. One source can end midway through a part. The next can begin there.

    A missing or unreadable file is skipped and reported. A file with a non-string source raises,
    because that is a --golden (label-less) file used as a train file.
    """
    by_source: dict[str, list[Path]] = {}
    skipped: list[tuple[Path, str]] = []
    multi: list[tuple[Path, list[str]]] = []
    for s in paths:
        if not s.exists():
            skipped.append((s, "file not found"))
            continue
        try:
            per_source = file_source_counts(s)
        except Exception as exc:
            skipped.append((s, str(exc)))
            continue
        if len(per_source) > 1:
            multi.append((s, sorted(per_source)))
        for src in per_source:
            by_source.setdefault(src, []).append(s)

    if skipped:
        logger.warning(
            "Skipped %d parquet files (missing or unreadable):\n  %s",
            len(skipped),
            "\n  ".join(f"{p}: {reason}" for p, reason in skipped[:10]),
        )
    if multi:
        logger.info(
            "%d parquet file(s) carry more than one source; each is indexed under all of them:\n  %s",
            len(multi),
            "\n  ".join(f"{p.name}: {', '.join(srcs)}" for p, srcs in multi[:10]),
        )
    logger.info(
        "Source index: %s",
        ", ".join(f"{src}={len(files)}" for src, files in sorted(by_source.items())),
    )
    return by_source


def _apply_source_weights(
    by_source: dict[str, list[Path]], source_weights: dict[str, float], split: str
) -> dict[str, list[Path]]:
    """Drop sources with zero weight. Refuse sources absent from the weights.

    A source with zero weight is the config declining it deliberately. A source absent from the weights
    is an oversight. The sampler cannot see that source. The run log contains no trace.
    Raise on the split whose recipe claims coverage when a source is unnamed. The
    A regenerated source may take a ``-vNN`` suffix. If the config keeps the old key, training
    silently continues on the superseded vintage.
    """
    unnamed = sorted(src for src in by_source if src not in source_weights)
    if unnamed and split == "train":
        detail = ", ".join(f"{src} ({len(by_source[src])} parquet files)" for src in unnamed)
        raise ValueError(
            f"{len(unnamed)} source(s) in the {split!r} split are absent from source_weights and would "
            f"be dropped without a trace: {detail}. Name each one — give it a weight to train on it, "
            "or 0.0 to decline it deliberately. Check for a superseded generation still holding the "
            "weight (a `-vNN` sibling of the same name)."
        )

    declined = {src for src in by_source if source_weights.get(src, 0) <= 0}
    kept = {src: files for src, files in by_source.items() if source_weights.get(src, 0) > 0}
    if declined:
        logger.info("Declined %d sources named at zero weight: %s", len(declined), sorted(declined))
    if not kept:
        raise ValueError(
            "no parquet files remain after applying source_weights — every file's source "
            f"is missing from or zero-weighted in source_weights={source_weights!r}"
        )
    return kept


def _stationary_mixture(
    weights: dict[str, float],
    fresh_iter: Callable[[str], Iterator[dict[str, Any]]],
    rng: random.Random,
) -> Iterator[dict[str, Any]]:
    """Draw a source per row from a multinomial fixed for the whole epoch.

    An exhausted source restarts with a fresh shuffled pass rather than leaving the mixture.
    The epoch ends once every source has completed at least one full pass. The largest source is seen
    exactly once. Each source remains in the mixture throughout the epoch.
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
            # A pass that yielded no rows can never yield on a rerun, so a positive-weight source with
            # zero selectable rows is a recipe/corpus interface violation and raises here.
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

    Wrapped by ``iter_rows`` with a reservoir-style shuffle buffer. The multinomial is fixed for the
    whole epoch, so the observed mix matches ``source_weights`` exactly per pull regardless of raw
    share or file layout. Non-train splits skip source bucketing and stream every file's rows directly.

    Memory is one active row-group per source, about ``|sources| × 50 MB`` peak.
    """
    paths = _parquet_paths(corpus_dir, split)
    max_weight = max(country_weights.values())

    if split != "train":
        yield from _stream_held_out(
            paths,
            split,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )
        return

    logger.info("Indexing %d parquet files by source...", len(paths))
    by_source = _index_by_source(paths)
    # ``source_weights`` describes the train mixture. Validation corpora intentionally hold a small
    # fixed source subset, so the stale-config guard applies only where the recipe makes its
    # coverage claim.
    if source_weights is not None and split == "train":
        missing_positive = sorted(src for src, weight in source_weights.items() if weight > 0 and src not in by_source)
        if missing_positive:
            raise ValueError(
                f"positive source_weights entries have no parquet files in the {split!r} split: "
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
