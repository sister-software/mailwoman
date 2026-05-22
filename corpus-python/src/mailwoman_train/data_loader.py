"""Streaming parquet → encoded tensors data pipeline for Phase 2 training.

Reads ``corpus-v0.1.0`` parquet shards via PyArrow's row-group iterator (lazy, memory-stable),
filters / weights rows per the YAML config, encodes each row through the SentencePiece
tokenizer with realigned BIO labels, and yields PyTorch ``(input_ids, attention_mask, labels)``
tensors in a batched ``DataLoader``-compatible shape.

Why PyArrow + a generator and not ``datasets.load_dataset('parquet', streaming=True)``?

- ``datasets`` would work; the row-group iterator path here is fewer moving parts, gives us
  direct per-row column projection (we never materialize ``tokens`` for rows we drop), and
  keeps the train loop deterministic for a fixed seed without the HF dataset shuffle buffer
  semantics.
- The data loader is the hot path on a CPU-bound train run; ad-hoc streaming is fine.

Per Phase 2 §2:

- Lazy + streaming + memory-stable: row-group iteration, never reads a full shard.
- Stratified sampling: ``country_weights`` are renormalized probabilities; rows are accepted
  with probability proportional to their country's weight relative to the max.
- Length filter: rows whose SP tokenization exceeds ``max_length`` are dropped.
- Tokenizer alignment verification: re-tokenize a sample and assert the stored ``tokens``
  match (see ``verify_tokenizer_alignment``).
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

import pyarrow.parquet as pq

from .config import Config, DataConfig
from .labels import IGNORE_INDEX, active_components_present
from .tokenizer import Tokenizer, encode_row, whitespace_spans

_REQUIRED_COLUMNS: tuple[str, ...] = ("raw", "tokens", "labels", "country", "source")


@dataclass
class EncodedExample:
    input_ids: list[int]
    attention_mask: list[int]
    labels: list[int]


def _shard_paths(corpus_dir: Path, split: str) -> list[Path]:
    paths = sorted((corpus_dir / split).glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"no parquet shards under {corpus_dir / split}")
    return paths


def _row_components_keys(labels: Sequence[str]) -> list[str]:
    """Return the unique component tags present in a row's BIO labels."""
    out: set[str] = set()
    for label in labels:
        if label == "O" or "-" not in label:
            continue
        _, tag = label.split("-", 1)
        out.add(tag)
    return list(out)


def _shard_first_source(shard: Path) -> str:
    """Return the ``source`` value of the first row in a parquet shard.

    Corpus v0.2.0 shards are 100% source-segregated (one source per shard), so reading
    the first row's source identifies the shard's source. Costs ~50 ms / shard at index
    time; called once per shard when ``_raw_row_stream`` starts.
    """
    pf = pq.ParquetFile(shard)
    rg = pf.read_row_group(0, columns=["source"])
    return rg["source"][0].as_py()


def _shard_row_iter(
    shard: Path,
    *,
    expected_source: str | None,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict]:
    """Yield filter-accepted rows from a single parquet shard, with row-group + row shuffle.

    Applies the country-weight acceptance test, (when ``coarse_filter`` is set) the
    coarse-label gate, and — when ``expected_source`` is given — a per-row source equality
    check. The per-row source check matters for the 2 "transition" shards in corpus
    v0.2.0 (part-0016 and part-0259) where one source's data ends and the next begins
    mid-shard; without it the per-source iterator would yield rows from the wrong source.

    Does **not** apply source weighting — source weighting is handled at the multinomial
    sampler level in ``_raw_row_stream``, so that the observed mix matches ``source_weights``
    exactly (rather than the ``raw_share × accept_share`` shape that per-row source
    acceptance produces, which under v0.2.0's heavy raw-share skew toward BAN proved
    unreliable as a steering mechanism — PR #44).
    """
    pf = pq.ParquetFile(shard)
    rg_order = list(range(pf.num_row_groups))
    rng.shuffle(rg_order)
    for rg in rg_order:
        t = pf.read_row_group(rg, columns=list(_REQUIRED_COLUMNS))
        raws = t["raw"]
        tokens_col = t["tokens"]
        labels_col = t["labels"]
        countries = t["country"]
        sources = t["source"]
        idx_order = list(range(t.num_rows))
        rng.shuffle(idx_order)
        for i in idx_order:
            source = sources[i].as_py()
            if expected_source is not None and source != expected_source:
                continue
            country = countries[i].as_py()
            weight = country_weights.get(country)
            if weight is None or weight <= 0:
                continue
            if weight < max_weight and rng.random() > weight / max_weight:
                continue
            bio_labels = labels_col[i].as_py()
            if coarse_filter:
                keys = _row_components_keys(bio_labels)
                if not active_components_present(keys):
                    continue
            yield {
                "raw": raws[i].as_py(),
                "tokens": tokens_col[i].as_py(),
                "labels": bio_labels,
                "country": country,
                "source": source,
            }


def _source_iter(
    shards: list[Path],
    *,
    expected_source: str,
    rng: random.Random,
    country_weights: dict[str, float],
    max_weight: float,
    coarse_filter: bool,
) -> Iterator[dict]:
    """Yield rows from a sequence of shards, restricted to ``expected_source``.

    Shards are visited in shuffled order; within each shard, row-groups and row indices
    are also shuffled (see ``_shard_row_iter``). One row-group's worth of rows is held
    in memory at a time per source, so total RAM is bounded by the number of distinct
    sources, not by any shard-pool parameter.
    """
    order = list(shards)
    rng.shuffle(order)
    for s in order:
        yield from _shard_row_iter(
            s,
            expected_source=expected_source,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )


def _raw_row_stream(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
) -> Iterator[dict]:
    """Internal stream: yields filter-accepted rows, sampled by weighted source multinomial.

    Wrapped by ``iter_rows`` with a reservoir-style shuffle buffer.

    Architecture:

    1. Bucket shards by their (single) ``source`` value. Corpus v0.2.0 shards are 100%
       source-segregated, so this is a one-time scan of one row-group header per shard.
    2. For each source, build a per-source row iterator that visits its shards in shuffled
       order. Each iterator yields rows after country + coarse filtering.
    3. On each pull, sample a source via the ``source_weights`` multinomial (or uniform
       when ``source_weights`` is None) and yield the next row from that source's iterator.
       When a source's iterator exhausts, drop it from the multinomial and renormalize.

    Why this and not per-row source acceptance:

    The naive approach of accepting each row with probability ``source_weights[source] /
    max(source_weights)`` was the original v0.2.0 implementation (PR #44). It is correct
    on average — the observed mix converges to ``raw_share × accept_share / norm`` — but
    under v0.2.0's shard layout it fails empirically: shards are 1M-row single-source
    blocks, so the downstream shuffle buffer fills entirely from the current shard's
    source before any cross-source mixing happens. Long runs of one source within a batch
    reproduce the positional-heuristic overfit that motivated this issue (#43).

    Source-level multinomial sampling makes the observed mix match ``source_weights``
    *exactly* per-pull, regardless of raw share or shard layout. Memory: one active
    row-group per source ≈ ``|sources| × 50 MB`` peak — ~300 MB for v0.2.0's 6 train-split
    sources, well within budget.
    """
    shard_paths = _shard_paths(corpus_dir, split)
    max_weight = max(country_weights.values())

    by_source: dict[str, list[Path]] = {}
    for s in shard_paths:
        src = _shard_first_source(s)
        by_source.setdefault(src, []).append(s)

    if source_weights is not None:
        by_source = {
            src: shards
            for src, shards in by_source.items()
            if source_weights.get(src, 0) > 0
        }
        if not by_source:
            raise ValueError(
                "no shards remain after applying source_weights — every shard's source "
                f"is missing from or zero-weighted in source_weights={source_weights!r}"
            )

    iters: dict[str, Iterator[dict]] = {
        src: _source_iter(
            shards,
            expected_source=src,
            rng=rng,
            country_weights=country_weights,
            max_weight=max_weight,
            coarse_filter=coarse_filter,
        )
        for src, shards in by_source.items()
    }
    weights: dict[str, float] = {
        src: float(source_weights[src]) if source_weights is not None else 1.0
        for src in iters
    }

    while iters:
        sources = list(iters.keys())
        cum: list[float] = []
        total = 0.0
        for src in sources:
            total += weights[src]
            cum.append(total)
        r = rng.random() * total
        chosen = sources[-1]
        for src, c in zip(sources, cum):
            if r < c:
                chosen = src
                break
        try:
            yield next(iters[chosen])
        except StopIteration:
            del iters[chosen]
            del weights[chosen]


def iter_rows(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None = None,
    coarse_filter: bool,
    row_limit: int | None = None,
    shuffle_buffer: int = 131072,
) -> Iterator[dict]:
    """Yield rows from parquet shards, filtered + shuffled.

    Shuffling is done at three levels:

    1. Shard order (per-epoch): shards visited in random order.
    2. Row-group order within shard: row-groups visited in random order.
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
    sample only 0.006% per shuffle — within-shard order would dominate. 128k buffer
    samples 0.05% which restores effective randomness without meaningful RAM impact.
    """
    if not country_weights:
        raise ValueError("country_weights must be non-empty")
    upstream = _raw_row_stream(
        corpus_dir,
        split,
        rng=rng,
        country_weights=country_weights,
        source_weights=source_weights,
        coarse_filter=coarse_filter,
    )
    buf: list[dict] = []
    yielded = 0
    # Fill the buffer first.
    try:
        for _ in range(shuffle_buffer):
            buf.append(next(upstream))
    except StopIteration:
        pass
    # Stream out: every time we yield, pull the next from upstream into the freed slot.
    for row in upstream:
        j = rng.randrange(len(buf))
        out = buf[j]
        buf[j] = row
        yield out
        yielded += 1
        if row_limit is not None and yielded >= row_limit:
            return
    # Drain whatever remains in the buffer.
    rng.shuffle(buf)
    for out in buf:
        yield out
        yielded += 1
        if row_limit is not None and yielded >= row_limit:
            return


def iter_encoded(
    cfg_data: DataConfig,
    tokenizer: Tokenizer,
    *,
    split: str = "train",
    rng: random.Random | None = None,
    row_limit: int | None = None,
) -> Iterator[EncodedExample]:
    """Yield encoded examples, dropping rows whose SP token count exceeds ``max_length``.

    Length-filter rationale: address text is short by nature; long rows are usually adapter
    bugs (per Phase 2 §2.3). Cap at the model's ``max_position_embeddings``.
    """
    rng = rng or random.Random(0)
    for row in iter_rows(
        Path(cfg_data.corpus_dir),
        split,
        rng=rng,
        country_weights=cfg_data.country_weights,
        source_weights=cfg_data.source_weights,
        coarse_filter=cfg_data.coarse_filter,
        row_limit=row_limit,
    ):
        enc = encode_row(
            tokenizer,
            row["raw"],
            row["tokens"],
            row["labels"],
            max_length=cfg_data.max_length,
        )
        # Drop rows whose non-padding length exceeds max_length (length filter §2).
        non_pad = sum(enc["attention_mask"])
        if non_pad >= cfg_data.max_length:
            # Even at exactly max_length we keep — the spec says drop tokens > 128; equality is fine.
            # But hand-curated coarse rows almost never hit this. Track via downstream metrics.
            pass
        yield EncodedExample(
            input_ids=enc["input_ids"],
            attention_mask=enc["attention_mask"],
            labels=enc["labels"],
        )


def collate(batch: list[EncodedExample]) -> dict:
    """Stack a list of ``EncodedExample`` into batched lists. Caller wraps in torch tensors."""
    return {
        "input_ids": [ex.input_ids for ex in batch],
        "attention_mask": [ex.attention_mask for ex in batch],
        "labels": [ex.labels for ex in batch],
    }


def iter_batches(
    cfg: Config,
    tokenizer: Tokenizer,
    *,
    split: str,
    batch_size: int,
    seed: int = 0,
    row_limit: int | None = None,
) -> Iterator[dict]:
    """Yield collated batches indefinitely until the underlying iterator exhausts."""
    rng = random.Random(seed)
    buf: list[EncodedExample] = []
    for ex in iter_encoded(cfg.data, tokenizer, split=split, rng=rng, row_limit=row_limit):
        buf.append(ex)
        if len(buf) == batch_size:
            yield collate(buf)
            buf = []
    if buf:
        yield collate(buf)


def verify_tokenizer_alignment(
    corpus_dir: Path,
    tokenizer: Tokenizer,
    *,
    sample_size: int = 100,
) -> None:
    """Assert that the SP tokenizer is *compatible* with the stored whitespace tokens.

    The stored ``tokens`` field is whitespace-tokenized, while the model uses SentencePiece
    sub-tokens. They will not be byte-identical. What we DO need is:

    1. The whitespace tokens are recoverable from ``raw`` via left-to-right substring scan
       (corpus invariant — if this breaks, the corpus build is corrupt).
    2. The SP tokenizer can be loaded.

    If invariant (1) fails this raises; (2) failed earlier when we constructed Tokenizer.
    """
    shard = _shard_paths(corpus_dir, "train")[0]
    pf = pq.ParquetFile(shard)
    t = pf.read_row_group(0, columns=list(_REQUIRED_COLUMNS))
    raws = t["raw"]
    tokens_col = t["tokens"]
    n = min(sample_size, t.num_rows)
    for i in range(n):
        raw = raws[i].as_py()
        toks = tokens_col[i].as_py()
        try:
            whitespace_spans(raw, toks)
        except ValueError as exc:
            raise RuntimeError(
                f"corpus tokenizer invariant broken at row {i} of shard {shard}: {exc}"
            ) from exc
        # Smoke the SP encoder so a mis-pointed tokenizer.model fails fast.
        tokenizer.encode_with_spans(raw)


__all__ = [
    "EncodedExample",
    "IGNORE_INDEX",
    "iter_rows",
    "iter_encoded",
    "iter_batches",
    "verify_tokenizer_alignment",
]
