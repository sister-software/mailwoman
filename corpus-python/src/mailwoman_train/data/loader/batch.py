"""Assemble the batches the trainer feeds the model.

The SentencePiece path hands each batch of sampled rows to the row encoder, which returns `[B, L]` and
`[B, L, D]` arrays, and adds each row's locale and address-system ids in row order. The char path stacks one
`EncodedExample` per row with `collate`. A channel is present in a batch only when its lexicon is configured. An
absent channel is omitted rather than zero-filled, so the trainer's tensor conversion skips it and the model runs
without it.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Iterator
from typing import Any

import mailwoman_mtf

from ...address_systems import address_system_id
from ...config import Config
from ...labels import locale_id
from .encode import encode_char_row, iter_sampled_rows, require_label_set_supported, resolve_char_mode
from .example import EncodedExample


def collate(batch: list[EncodedExample]) -> dict[str, Any]:
    """Stack a list of ``EncodedExample`` into batched lists. Caller wraps in torch tensors."""
    out = {
        "input_ids": [ex.input_ids for ex in batch],
        "attention_mask": [ex.attention_mask for ex in batch],
        "labels": [ex.labels for ex in batch],
        "locale_ids": [ex.locale_id for ex in batch],
        "address_system_ids": [ex.address_system_id for ex in batch],
    }
    for channel in mailwoman_mtf.CHANNEL_NAMES:
        if batch and getattr(batch[0], f"{channel}_features") is not None:
            out[f"{channel}_features"] = [getattr(ex, f"{channel}_features") for ex in batch]
            out[f"{channel}_confidence"] = [getattr(ex, f"{channel}_confidence") for ex in batch]
    # CharCNN input path (#825 / v8 CJK): same presence interface — set iff char_mode != "off".
    if batch and batch[0].char_ids is not None:
        out["char_ids"] = [ex.char_ids for ex in batch]
    return out


def encode_rows(encoder: mailwoman_mtf.RowEncoder, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """One batch from the row encoder, with each row's locale and address-system ids in row order."""
    out: dict[str, Any] = dict(encoder.encode_batch(rows))
    out["locale_ids"] = [locale_id(row.get("country")) for row in rows]
    out["address_system_ids"] = [address_system_id(row.get("country"), row["raw"]) for row in rows]
    return out


def iter_batch_rows(
    cfg: Config, *, split: str, batch_size: int, seed: int, row_limit: int | None = None
) -> Iterator[list[dict[str, Any]]]:
    """Yield the sampled rows of each batch, unencoded, ending with a partial batch when the rows run out.

    The encoder leaves the sampler's generator untouched. The rows a batch holds therefore depend only on the seed and
    the batches drawn before it.
    """
    rng = random.Random(seed)
    rows: list[dict[str, Any]] = []
    for row in iter_sampled_rows(cfg.data, split, rng=rng, row_limit=row_limit):
        rows.append(row)
        if len(rows) == batch_size:
            yield rows
            rows = []
    if rows:
        yield rows


def batch_encoder(
    cfg: Config, encoder: mailwoman_mtf.RowEncoder | None
) -> Callable[[list[dict[str, Any]]], dict[str, Any]]:
    """Return the function that turns one batch of sampled rows into the batch the model reads.

    ``encoder`` is the row encoder the process built with `build_row_encoder`, or None on the char path.
    """
    char = resolve_char_mode(cfg.data)
    label_set = require_label_set_supported(cfg.data, char)
    if char is not None:
        return lambda rows: collate([encode_char_row(row, char, label_set) for row in rows])
    if encoder is None:
        raise ValueError("the SentencePiece path requires a row encoder (build_row_encoder)")
    return lambda rows: encode_rows(encoder, rows)


def iter_batches(
    cfg: Config,
    encoder: mailwoman_mtf.RowEncoder | None,
    *,
    split: str,
    batch_size: int,
    seed: int = 0,
    row_limit: int | None = None,
    observer: Callable[[dict[str, Any]], None] | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield batches until the sampled rows run out.

    ``observer`` receives each source row of a batch once the consumer asks for the batch after it, so a batch
    fetched and then abandoned (the loop breaking at ``max_steps``) is never observed.
    """
    encode = batch_encoder(cfg, encoder)
    for rows in iter_batch_rows(cfg, split=split, batch_size=batch_size, seed=seed, row_limit=row_limit):
        yield encode(rows)
        if observer:
            for row in rows:
                observer(row)


def iter_training_batches(
    cfg: Config,
    encoder: mailwoman_mtf.RowEncoder | None,
    *,
    batch_size: int,
    seed: int,
    row_limit: int | None = None,
    skip_batches: int = 0,
    observer: Callable[[dict[str, Any]], None] | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield the train split's batches without end, reopening the stream with ``seed + epoch`` for epochs 1, 2, ….

    A resumed run passes the number of batches its earlier attempts consumed as ``skip_batches``. Those batches are
    sampled in order and dropped before encoding, and the observer never sees them, so the stream continues with the
    batch an uninterrupted run would read next. ``observer`` has the semantics of `iter_batches`.
    """
    encode = batch_encoder(cfg, encoder)
    remaining = skip_batches
    epoch = 0
    while True:
        epoch += 1
        drawn = 0
        for rows in iter_batch_rows(cfg, split="train", batch_size=batch_size, seed=seed + epoch, row_limit=row_limit):
            drawn += 1
            if remaining > 0:
                remaining -= 1
                continue
            yield encode(rows)
            if observer:
                for row in rows:
                    observer(row)
        if drawn == 0:
            raise ValueError(f"the train split yielded no rows in epoch {epoch} (seed {seed + epoch})")
