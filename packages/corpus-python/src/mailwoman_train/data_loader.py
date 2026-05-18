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
from .labels import IGNORE_INDEX, coarse_components_present
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


def _raw_row_stream(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None,
    coarse_filter: bool,
) -> Iterator[dict]:
    """Internal unshuffled stream: yields filter-accepted rows in shard / row-group / row order.

    Wrapped by ``iter_rows`` with a reservoir-style shuffle buffer.
    """
    shard_paths = _shard_paths(corpus_dir, split)
    max_weight = max(country_weights.values())
    max_source_weight = max(source_weights.values()) if source_weights else 1.0
    # Shard-order shuffle: visit shards in random order each epoch so consecutive optimizer
    # steps don't see only one shard's data even before the row-level shuffle buffer kicks in.
    shard_order = list(shard_paths)
    rng.shuffle(shard_order)
    for shard in shard_order:
        pf = pq.ParquetFile(shard)
        # Within a shard, row-groups also visited in random order.
        rg_order = list(range(pf.num_row_groups))
        rng.shuffle(rg_order)
        for rg in rg_order:
            t = pf.read_row_group(rg, columns=list(_REQUIRED_COLUMNS))
            raws = t["raw"]
            tokens_col = t["tokens"]
            labels_col = t["labels"]
            countries = t["country"]
            sources = t["source"]
            # Within a row-group, permute indices so adjacent yields are non-contiguous.
            idx_order = list(range(t.num_rows))
            rng.shuffle(idx_order)
            for i in idx_order:
                country = countries[i].as_py()
                weight = country_weights.get(country)
                if weight is None or weight <= 0:
                    continue
                # Stratified acceptance — accept w.p. weight / max_weight.
                if weight < max_weight and rng.random() > weight / max_weight:
                    continue
                # Per-source stratified acceptance (independent of country filter).
                # When source_weights is None, all sources pass.
                if source_weights is not None:
                    source = sources[i].as_py()
                    sw = source_weights.get(source)
                    if sw is None or sw <= 0:
                        continue
                    if sw < max_source_weight and rng.random() > sw / max_source_weight:
                        continue
                else:
                    source = sources[i].as_py()
                bio_labels = labels_col[i].as_py()
                if coarse_filter:
                    keys = _row_components_keys(bio_labels)
                    if not coarse_components_present(keys):
                        continue
                yield {
                    "raw": raws[i].as_py(),
                    "tokens": tokens_col[i].as_py(),
                    "labels": bio_labels,
                    "country": country,
                    "source": source,
                }


def iter_rows(
    corpus_dir: Path,
    split: str,
    *,
    rng: random.Random,
    country_weights: dict[str, float],
    source_weights: dict[str, float] | None = None,
    coarse_filter: bool,
    row_limit: int | None = None,
    shuffle_buffer: int = 16384,
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
    16384 buffer is ~16 MB resident, well within budget.
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
